/**
 * Turns the reader path's claims into observations. Needs a real Postgres:
 *
 *   DATABASE_URL=postgres://user:pass@localhost:5432/db pnpm --filter @insightkit/core smoke
 *
 * Read-only. It writes nothing and creates nothing; the one write it attempts is
 * expected to be refused, which is the point.
 */
import { createGuard } from '@insightkit/sql-guard';
import pg from 'pg';
import { approve, asReaderSource, introspectSchema, runGuardedRead } from '../dist/index.js';
import { fromPgPool } from '../dist/pg.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('set DATABASE_URL first');
  process.exit(2);
}

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000, max: 2 });
const source = asReaderSource(fromPgPool(pool));

try {
  const version = await pool.query('SHOW server_version');
  console.log(`\nPostgres ${version.rows[0].server_version}\n`);

  const guard = await createGuard({ maxRows: 1000 });

  const approval = approve(guard, 'SELECT 1 AS n');
  if (!approval.ok) throw new Error(`guard refused the smoke query: ${approval.code}`);
  const read = await runGuardedRead(source, approval.query);
  record(
    'a guarded SELECT runs and comes back',
    read.rows.rows[0]?.[0] === 1,
    `columns ${JSON.stringify(read.rows.columns)}, rows ${JSON.stringify(read.rows.rows)}`,
  );
  record(
    'the row cap reached the server',
    read.statements.some((s) => s.includes('LIMIT 1000')),
    read.statements.find((s) => s.startsWith('SELECT')),
  );
  record(
    'the transaction was opened read only and rolled back',
    read.statements[0] === 'BEGIN READ ONLY' && read.statements.at(-1) === 'ROLLBACK',
  );

  // The claim under test is the database's, not ours, so this goes around sql-guard
  // deliberately: it is layer 3 on its own, with layer 1 removed.
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    let code = null;
    try {
      await client.query('CREATE TEMP TABLE insightkit_smoke_should_not_exist (i int)');
    } catch (err) {
      code = err.code;
    }
    record(
      'BEGIN READ ONLY actually refuses a write',
      code === '25006',
      code === null ? 'the write SUCCEEDED' : `SQLSTATE ${code}`,
    );
    const ro = await client.query('SHOW transaction_read_only');
    record('the server reports the transaction read only', ro.rows[0].transaction_read_only === 'on');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  const c2 = await source.connect();
  try {
    const day = await c2.query("SELECT DATE '2026-09-05' AS day, TIMESTAMP '2026-09-05 13:45:00' AS at");
    const [d, at] = day.rows[0];
    record('a date survives the driver unshifted', d === '2026-09-05', `got ${JSON.stringify(d)}`);
    record(
      'a timestamp keeps the reading Postgres sent',
      at === '2026-09-05 13:45:00',
      `got ${JSON.stringify(at)}`,
    );
    const n = await c2.query('SELECT 9007199254740993::int8 AS big, count(*) FROM (SELECT 1) t');
    record('int8 keeps its precision', n.rows[0][0] === '9007199254740993', `got ${JSON.stringify(n.rows[0][0])}`);
  } finally {
    c2.release();
  }

  // Parsing proved these are valid Postgres. Only a server proves they run.
  const schema = await introspectSchema(source, { excludeSchemas: ['insightkit'] });
  record(
    'the catalog queries execute',
    true,
    `${schema.tables.length} tables, ${schema.foreignKeys.length} foreign keys, as ${schema.observedAs}`,
  );
  record(
    'no system schema leaked into the description',
    schema.tables.every((t) => !t.schema.startsWith('pg_') && t.schema !== 'information_schema'),
    [...new Set(schema.tables.map((t) => t.schema))].join(', ') || '(no tables visible)',
  );
  const withPk = schema.tables.filter((t) => t.primaryKey.length > 0);
  record(
    'primary keys come back in order',
    withPk.every((t) => t.primaryKey.every((c) => t.columns.some((col) => col.name === c))),
    `${withPk.length} tables with a primary key`,
  );
  record(
    'every foreign key points at a table that was described',
    schema.foreignKeys.every((fk) =>
      schema.tables.some((t) => t.schema === fk.to.schema && t.name === fk.to.table),
    ),
    `${schema.foreignKeys.length} checked`,
  );
} catch (err) {
  record('smoke run completed', false, err.message);
} finally {
  await pool.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
