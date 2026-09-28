import type { Guard } from '@insightkit/sql-guard';
import { createGuard } from '@insightkit/sql-guard';
import { beforeAll, describe, expect, it } from 'vitest';
import { approve } from '../src/approve.js';
import type { ColumnInfo, ForeignKey, TableInfo } from '../src/introspect/types.js';
import type { ChartSpec } from '../src/plan/types.js';
import { defineGlossary } from '../src/semantic/glossary.js';
import { asAdminSource, asReaderSource } from '../src/source.js';
import { cacheKey, glossaryDigest, normalizeQuestion, schemaDigest } from '../src/store/key.js';
import {
  bootstrapStatements,
  MIGRATIONS,
  migrationChecksum,
  pendingMigrations,
  runMigrations,
} from '../src/store/migrations.js';
import { createQueryStore } from '../src/store/store.js';
import type { CacheKeyInput, RejectedEntry } from '../src/store/types.js';
import { StoreError } from '../src/store/types.js';
import { composeStatement, inWriteTransaction, writePreamble } from '../src/store/write.js';
import type { AdminSource, GuardedQuery, QueryOutcome, SqlClient } from '../src/types.js';

const EMPTY: QueryOutcome = { fields: [], rows: [] };
const rows = (values: unknown[][]): QueryOutcome => ({ fields: [], rows: values });

interface Harness {
  readonly log: string[];
  readonly released: boolean[];
  readonly source: AdminSource;
  readonly raw: { connect: () => Promise<SqlClient> };
}

function harness(handler?: (sql: string) => QueryOutcome | Promise<QueryOutcome>): Harness {
  const log: string[] = [];
  const released: boolean[] = [];
  const client: SqlClient = {
    async query(text) {
      log.push(text);
      return handler ? await handler(text) : EMPTY;
    },
    release(destroy) {
      released.push(destroy === true);
    },
  };
  const raw = { connect: async () => client };
  return { log, released, raw, source: asAdminSource(raw) };
}

const col = (name: string, dataType = 'text', extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType,
  typeOid: 25,
  nullable: true,
  comment: null,
  ...extra,
});

const table = (
  schema: string,
  name: string,
  columns: readonly ColumnInfo[],
  extra: Partial<TableInfo> = {},
): TableInfo => ({
  schema,
  name,
  kind: 'table',
  comment: null,
  estimatedRows: 0,
  primaryKey: [],
  columns,
  ...extra,
});

const USERS = table('public', 'users', [col('id', 'integer'), col('email'), col('created_at', 'date')]);
const ORDERS = table('public', 'orders', [col('id', 'integer'), col('user_id', 'integer')]);

const FK: ForeignKey = {
  name: 'orders_user_id_fkey',
  from: { schema: 'public', table: 'orders', columns: ['user_id'] },
  to: { schema: 'public', table: 'users', columns: ['id'] },
};

const CHART: ChartSpec = { kind: 'bar', x: 'day', y: ['signups'], series: null, title: 'Signups' };

const QUESTION = 'how many users joined this week';
const KEY_INPUT: CacheKeyInput = { question: QUESTION, tables: [USERS] };

let guard: Guard;
let query: GuardedQuery;

const approved = (sql: string): GuardedQuery => {
  const a = approve(guard, sql);
  if (!a.ok) throw new Error(`fixture should be approved: ${a.detail}`);
  return a.query;
};

beforeAll(async () => {
  guard = await createGuard({ maxRows: 1000 });
  query = approved('SELECT id FROM users');
});

const CACHED = (sql: string, chart = JSON.stringify(CHART)): unknown[][] => [
  ['k', QUESTION, sql, chart, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '3', null],
];

const savingHarness = (): Harness =>
  harness((sql) => (sql.startsWith('INSERT INTO') ? rows([['k', '2026-09-01T00:00:00Z', null]]) : EMPTY));

describe('the cache key', () => {
  it('is stable for the same question, schema and glossary', () => {
    expect(cacheKey(KEY_INPUT).key).toBe(cacheKey({ ...KEY_INPUT }).key);
  });

  it('changes when the schema changes, though the question is identical', () => {
    const widened = table('public', 'users', [...USERS.columns, col('deleted_at', 'timestamptz')]);
    expect(cacheKey({ question: QUESTION, tables: [widened] }).key).not.toBe(cacheKey(KEY_INPUT).key);

    const retyped = table('public', 'users', [col('id', 'bigint'), col('email'), col('created_at', 'date')]);
    expect(cacheKey({ question: QUESTION, tables: [retyped] }).key).not.toBe(cacheKey(KEY_INPUT).key);
  });

  it('changes when a dropped column narrows the schema', () => {
    const narrowed = table('public', 'users', [col('id', 'integer'), col('email')]);
    expect(cacheKey({ question: QUESTION, tables: [narrowed] }).key).not.toBe(cacheKey(KEY_INPUT).key);
  });

  it('changes when the glossary changes, though the question is identical', () => {
    const a = defineGlossary([{ term: 'active user', definition: 'signed in this month' }]);
    const b = defineGlossary([{ term: 'active user', definition: 'signed in this week' }]);
    const key = (glossary: ReturnType<typeof defineGlossary>) => cacheKey({ ...KEY_INPUT, glossary }).key;
    expect(key(a)).not.toBe(key(b));
    expect(key(a)).not.toBe(cacheKey(KEY_INPUT).key);
  });

  it('changes when an unrelated glossary entry is added, because it changes what would match', () => {
    const one = defineGlossary([{ term: 'churn', definition: 'left last month' }]);
    const two = defineGlossary([
      { term: 'churn', definition: 'left last month' },
      { term: 'week', definition: 'monday to sunday' },
    ]);
    expect(cacheKey({ ...KEY_INPUT, glossary: one }).key).not.toBe(
      cacheKey({ ...KEY_INPUT, glossary: two }).key,
    );
  });

  it('changes when the retrieved table set changes, though the question is identical', () => {
    expect(cacheKey({ question: QUESTION, tables: [USERS, ORDERS] }).key).not.toBe(cacheKey(KEY_INPUT).key);
  });

  it('changes when a foreign key between the retrieved tables appears', () => {
    const both = { question: QUESTION, tables: [USERS, ORDERS] };
    expect(cacheKey({ ...both, foreignKeys: [FK] }).key).not.toBe(cacheKey(both).key);
  });

  it('does not depend on the order the tables were retrieved in', () => {
    expect(cacheKey({ question: QUESTION, tables: [USERS, ORDERS] }).key).toBe(
      cacheKey({ question: QUESTION, tables: [ORDERS, USERS] }).key,
    );
  });

  it('ignores row estimates, which move on every autovacuum without changing the answer', () => {
    const busy = table('public', 'users', USERS.columns, { estimatedRows: 4_000_000 });
    expect(cacheKey({ question: QUESTION, tables: [busy] }).key).toBe(cacheKey(KEY_INPUT).key);
  });

  it('includes a table comment, because it reaches the prompt', () => {
    const commented = table('public', 'users', USERS.columns, { comment: 'people, not robots' });
    expect(cacheKey({ question: QUESTION, tables: [commented] }).key).not.toBe(cacheKey(KEY_INPUT).key);
  });

  it('separates the planner version, the row cap and the guidance', () => {
    expect(cacheKey({ ...KEY_INPUT, plannerVersion: 'v2' }).key).not.toBe(cacheKey(KEY_INPUT).key);
    expect(cacheKey({ ...KEY_INPUT, maxRows: 100 }).key).not.toBe(cacheKey(KEY_INPUT).key);
    expect(cacheKey({ ...KEY_INPUT, guidance: 'fiscal year starts in April' }).key).not.toBe(
      cacheKey(KEY_INPUT).key,
    );
  });

  it('normalises whitespace but not case', () => {
    expect(normalizeQuestion('  how   many\nusers ')).toBe('how many users');
    expect(cacheKey({ ...KEY_INPUT, question: `  ${QUESTION}  ` }).key).toBe(cacheKey(KEY_INPUT).key);
    expect(cacheKey({ ...KEY_INPUT, question: QUESTION.toUpperCase() }).key).not.toBe(
      cacheKey(KEY_INPUT).key,
    );
  });

  it('cannot be confused by moving text across fields', () => {
    const a = cacheKey({ question: 'ab', tables: [USERS], plannerVersion: 'c' });
    const b = cacheKey({ question: 'a', tables: [USERS], plannerVersion: 'bc' });
    expect(a.key).not.toBe(b.key);
  });

  it('cannot be collided by a list element that contains the separator', () => {
    // list() used to join on a NUL inside a single part, so ['a\0b'] and ['a','b']
    // produced identical bytes and the outer length prefix could not tell them apart.
    // Glossary synonyms are arbitrary host-authored strings, so this was reachable.
    const withSynonyms = (synonyms: readonly string[]): string =>
      cacheKey({
        ...KEY_INPUT,
        glossary: defineGlossary([{ term: 'mrr', synonyms: [...synonyms], definition: 'revenue' }]),
      }).key;
    expect(withSynonyms(['a\u0000b'])).not.toBe(withSynonyms(['a', 'b']));
  });

  it('refuses an empty question rather than keying everything to one hash', () => {
    expect(() => cacheKey({ question: '   ', tables: [USERS] })).toThrow(/needs a question/);
  });

  it('exposes the component digests so a miss is explainable', () => {
    const id = cacheKey(KEY_INPUT);
    expect(id.schemaDigest).toBe(schemaDigest([USERS]));
    expect(id.glossaryDigest).toBe(glossaryDigest(null));
    expect(id.key).toHaveLength(64);
  });
});

describe('the write transaction', () => {
  it('refuses a ReaderSource and accepts only an AdminSource', async () => {
    const h = harness();
    const reader = asReaderSource(h.raw);
    await expect(
      inWriteTransaction(reader as unknown as AdminSource, 'insightkit', async () => 1),
    ).rejects.toThrow(/asAdminSource/);
    expect(h.log).toEqual([]);
    await expect(inWriteTransaction(h.source, 'insightkit', async () => 1)).resolves.toBe(1);
  });

  it('refuses an unbranded source that merely has the right shape', async () => {
    const h = harness();
    await expect(
      inWriteTransaction(h.raw as unknown as AdminSource, 'insightkit', async () => 1),
    ).rejects.toThrow(/asAdminSource/);
  });

  it('commits on success and never rolls back', async () => {
    const h = harness();
    await inWriteTransaction(h.source, 'insightkit', async (run) => {
      await run(composeStatement('SELECT 1 FROM "insightkit"."approved_query"', 'insightkit'));
    });
    expect(h.log[0]).toBe('BEGIN');
    expect(h.log.at(-1)).toBe('COMMIT');
    expect(h.log).not.toContain('ROLLBACK');
    expect(h.released).toEqual([false]);
  });

  it('rolls back and never commits when the body throws', async () => {
    const h = harness();
    await expect(
      inWriteTransaction(h.source, 'insightkit', async () => {
        throw new Error('constraint violation');
      }),
    ).rejects.toThrow('constraint violation');
    expect(h.log.at(-1)).toBe('ROLLBACK');
    expect(h.log).not.toContain('COMMIT');
  });

  it('destroys the connection when even the rollback fails', async () => {
    const h = harness((sql) => {
      if (sql === 'ROLLBACK') throw new Error('connection reset');
      throw new Error('statement failed');
    });
    await expect(inWriteTransaction(h.source, 'insightkit', async () => 1)).rejects.toThrow();
    expect(h.released).toEqual([true]);
  });

  it('scopes every setting to the transaction, so none leaks onto the next borrower', async () => {
    const h = harness();
    await inWriteTransaction(h.source, 'insightkit', async () => 1);
    const settings = h.log.filter((s) => /^SET\b/.test(s));
    expect(settings.length).toBeGreaterThan(0);
    for (const s of settings) expect(s.startsWith('SET LOCAL ')).toBe(true);
  });

  it('bounds the transaction and pins the search path away from pg_temp', () => {
    const preamble = writePreamble('insightkit');
    expect(preamble).toContain("SET LOCAL statement_timeout = '10000ms'");
    expect(preamble).toContain("SET LOCAL lock_timeout = '2000ms'");
    expect(preamble).toContain("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
    expect(preamble).toContain('SET LOCAL standard_conforming_strings = on');
    expect(preamble).toContain('SET LOCAL search_path = pg_catalog, "insightkit"');
    expect(preamble.join(' ')).not.toContain('pg_temp');
  });

  it('refuses a timeout outside the permitted range', () => {
    expect(() => writePreamble('insightkit', { statementTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => writePreamble('insightkit', { lockTimeoutMs: 1.5 })).toThrow(RangeError);
  });

  it('only runs statements it composed itself', async () => {
    const h = harness();
    await expect(
      inWriteTransaction(h.source, 'insightkit', async (run) => {
        const forged = { text: 'DROP TABLE users' } as unknown as Parameters<typeof run>[0];
        return run(forged);
      }),
    ).rejects.toThrow(/composed/);
    expect(h.log).not.toContain('DROP TABLE users');
    expect(h.log.at(-1)).toBe('ROLLBACK');
  });

  it('refuses to compose a statement that reaches outside the metadata schema', () => {
    expect(() => composeStatement('DELETE FROM public.users', 'insightkit')).toThrow(/outside/);
    expect(() => composeStatement('SELECT 1 FROM public.users', 'insightkit')).toThrow(/outside/);
  });

  it('refuses a verb that is not on the allowlist', () => {
    expect(() => composeStatement('DROP TABLE "insightkit"."approved_query"', 'insightkit')).toThrow(
      /allowed verb/,
    );
    expect(() => composeStatement('GRANT ALL ON "insightkit"."x" TO ik_reader', 'insightkit')).toThrow(
      /allowed verb/,
    );
  });

  it('refuses an unsafe schema name rather than escaping it', () => {
    expect(() => writePreamble('a b')).toThrow(/plain SQL identifier/);
    expect(() => writePreamble('x"; DROP SCHEMA public; --')).toThrow(/plain SQL identifier/);
    expect(() => writePreamble('insight-kit')).toThrow(/plain SQL identifier/);
  });
});

const firstMigration = () => {
  const [first] = MIGRATIONS;
  if (first === undefined) throw new Error('the migration list must not be empty');
  return first;
};

describe('migrations', () => {
  interface Ledger {
    readonly harness: Harness;
    applied: { version: number; name: string; checksum: string }[];
    exists: boolean;
  }

  function ledgerFake(schema = 'insightkit'): Ledger {
    const state: Ledger = {
      applied: [],
      exists: false,
      harness: harness((sql) => {
        if (sql.startsWith('SELECT to_regclass')) {
          return rows([[state.exists ? `"${schema}"."schema_migrations"` : null]]);
        }
        if (sql.startsWith('SELECT version::text')) {
          return rows(state.applied.map((a) => [String(a.version), a.name, a.checksum]));
        }
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS') && sql.includes('schema_migrations')) {
          state.exists = true;
          return EMPTY;
        }
        const insert = /INSERT INTO .*schema_migrations.* VALUES \((\d+), '([^']+)', '([0-9a-f]+)'\)/s.exec(
          sql,
        );
        if (insert?.[1] !== undefined && insert[2] !== undefined && insert[3] !== undefined) {
          state.applied.push({ version: Number(insert[1]), name: insert[2], checksum: insert[3] });
        }
        return EMPTY;
      }),
    } as Ledger;
    return state;
  }

  const ddl = (log: readonly string[]): string[] =>
    log.filter((s) => s.startsWith('CREATE ') || s.startsWith('ALTER '));

  it('creates the schema, the ledger and the table on a first run', async () => {
    const fake = ledgerFake();
    const report = await runMigrations(fake.harness.source);
    expect(report.bootstrapped).toBe(true);
    expect(report.applied).toEqual([{ version: 1, name: 'approved_query' }]);
    const created = ddl(fake.harness.log);
    expect(created.some((s) => s.startsWith('CREATE SCHEMA IF NOT EXISTS "insightkit"'))).toBe(true);
    expect(created.some((s) => s.includes('"insightkit"."approved_query"'))).toBe(true);
    expect(fake.harness.log.at(-1)).toBe('COMMIT');
  });

  it('is idempotent: a second run issues no DDL at all', async () => {
    const fake = ledgerFake();
    await runMigrations(fake.harness.source);
    const before = fake.harness.log.length;
    const report = await runMigrations(fake.harness.source);
    expect(report.bootstrapped).toBe(false);
    expect(report.applied).toEqual([]);
    expect(report.alreadyApplied).toEqual([1]);
    expect(ddl(fake.harness.log.slice(before))).toEqual([]);
    expect(fake.harness.log.slice(before).filter((s) => s.startsWith('INSERT INTO'))).toEqual([]);
  });

  it('runs every DDL statement inside one transaction that commits', async () => {
    const fake = ledgerFake();
    await runMigrations(fake.harness.source);
    expect(fake.harness.log[0]).toBe('BEGIN');
    expect(fake.harness.log.at(-1)).toBe('COMMIT');
    expect(fake.harness.log.filter((s) => s === 'BEGIN')).toHaveLength(1);
  });

  it('every migration statement is idempotent on its own', () => {
    for (const statement of [
      ...bootstrapStatements('insightkit'),
      ...firstMigration().statements('insightkit'),
    ]) {
      expect(statement).toMatch(/IF NOT EXISTS/);
    }
  });

  it('refuses when the recorded checksum does not match the DDL this build carries', async () => {
    const fake = ledgerFake();
    fake.exists = true;
    fake.applied = [{ version: 1, name: 'approved_query', checksum: 'deadbeef' }];
    await expect(runMigrations(fake.harness.source)).rejects.toMatchObject({
      code: 'E_MIGRATION_CHECKSUM',
    });
    expect(fake.harness.log.at(-1)).toBe('ROLLBACK');
  });

  it('refuses a database migrated by a newer build rather than guessing', async () => {
    const fake = ledgerFake();
    fake.exists = true;
    fake.applied = [
      { version: 1, name: 'approved_query', checksum: migrationChecksum(firstMigration(), 'insightkit') },
      { version: 99, name: 'from_the_future', checksum: 'f00d' },
    ];
    await expect(runMigrations(fake.harness.source)).rejects.toMatchObject({
      code: 'E_MIGRATION_AHEAD',
    });
  });

  it('reports what is pending without writing anything', async () => {
    const fake = ledgerFake();
    expect(await pendingMigrations(fake.harness.source)).toHaveLength(1);
    expect(fake.harness.log[0]).toBe('BEGIN READ ONLY');
    expect(fake.harness.log.at(-1)).toBe('ROLLBACK');
    expect(fake.harness.log.some((s) => /commit/i.test(s))).toBe(false);
    expect(ddl(fake.harness.log)).toEqual([]);
  });

  it('refuses a ReaderSource', async () => {
    const h = harness();
    await expect(runMigrations(asReaderSource(h.raw) as unknown as AdminSource)).rejects.toThrow(
      /asAdminSource/,
    );
    await expect(pendingMigrations(asReaderSource(h.raw) as unknown as AdminSource)).rejects.toThrow(
      /asAdminSource/,
    );
  });

  it('refuses an unsafe metadata schema name rather than escaping it', async () => {
    const h = harness();
    await expect(runMigrations(h.source, { schema: 'a b' })).rejects.toThrow(/plain SQL identifier/);
    expect(() => bootstrapStatements('public"; DROP SCHEMA public; --')).toThrow(/plain SQL identifier/);
  });
});

describe('saving a plan', () => {
  it('writes to the configured metadata schema and nowhere else', async () => {
    const h = savingHarness();
    const store = createQueryStore(h.source, guard);
    await store.save({ key: KEY_INPUT, query, chart: CHART });

    const dml = h.log.filter((s) => /^(INSERT|UPDATE|DELETE|SELECT)/.test(s));
    expect(dml.length).toBeGreaterThan(0);
    for (const s of dml) expect(s).toContain('"insightkit"."approved_query"');
    expect(h.log.some((s) => /\bpublic\b/.test(s))).toBe(false);
    expect(h.log.at(-1)).toBe('COMMIT');
  });

  it('honours a different metadata schema everywhere', async () => {
    const h = savingHarness();
    const store = createQueryStore(h.source, guard, { schema: 'ik_meta' });
    await store.save({ key: KEY_INPUT, query, chart: CHART });
    expect(h.log).toContain('SET LOCAL search_path = pg_catalog, "ik_meta"');
    expect(h.log.some((s) => s.includes('"ik_meta"."approved_query"'))).toBe(true);
    expect(h.log.some((s) => s.includes('"insightkit"'))).toBe(false);
  });

  it('takes no SQL from the caller: the question is a literal, never a statement', async () => {
    const hostile = "'; DROP TABLE users; --";
    const h = savingHarness();
    const store = createQueryStore(h.source, guard);
    await store.save({ key: { question: hostile, tables: [USERS] }, query, chart: CHART });
    expect(h.log.some((s) => /drop\s+table/i.test(s.replace(/'[^']*'/g, '')))).toBe(false);
    expect(h.log.some((s) => s.includes("'''; DROP TABLE users; --'"))).toBe(true);
  });

  it('refuses a query that never went through approve', async () => {
    const h = savingHarness();
    const store = createQueryStore(h.source, guard);
    const forged = { sql: 'DELETE FROM users', tables: [], rowLimit: null } as unknown as GuardedQuery;
    await expect(store.save({ key: KEY_INPUT, query: forged, chart: CHART })).rejects.toMatchObject({
      code: 'E_NOT_APPROVED',
    });
    expect(h.log).toEqual([]);
  });

  it('rolls back and reports nothing saved when the insert fails', async () => {
    const h = harness((sql) => {
      if (sql.startsWith('INSERT INTO')) throw new Error('deadlock detected');
      return EMPTY;
    });
    const store = createQueryStore(h.source, guard);
    await expect(store.save({ key: KEY_INPUT, query, chart: CHART })).rejects.toThrow('deadlock');
    expect(h.log.at(-1)).toBe('ROLLBACK');
    expect(h.log).not.toContain('COMMIT');
  });

  it('caps the size of an entry rather than using the metadata schema as storage', async () => {
    const h = savingHarness();
    const store = createQueryStore(h.source, guard, { maxEntryBytes: 64 });
    await expect(store.save({ key: KEY_INPUT, query, chart: CHART })).rejects.toMatchObject({
      code: 'E_ENTRY_TOO_LARGE',
    });
    expect(h.log).toEqual([]);
  });

  it('gives an entry an expiry by default and none when the ttl is null', async () => {
    const withTtl = savingHarness();
    await createQueryStore(withTtl.source, guard).save({ key: KEY_INPUT, query, chart: CHART });
    expect(withTtl.log.some((s) => s.includes('make_interval(secs => 2592000.000)'))).toBe(true);

    const forever = savingHarness();
    await createQueryStore(forever.source, guard, { ttlMs: null }).save({
      key: KEY_INPUT,
      query,
      chart: CHART,
    });
    expect(forever.log.some((s) => s.includes('make_interval'))).toBe(false);
  });

  it('records the tenant for audit but keeps it out of the key', async () => {
    const a = savingHarness();
    const b = savingHarness();
    const store = (h: Harness) => createQueryStore(h.source, guard);
    const one = await store(a).save({ key: KEY_INPUT, query, chart: CHART, tenantId: 'acme' });
    const two = await store(b).save({ key: KEY_INPUT, query, chart: CHART, tenantId: 'globex' });
    expect(one.key).toBe(two.key);
    expect(a.log.some((s) => s.includes("'acme'"))).toBe(true);
    expect(b.log.some((s) => s.includes("'globex'"))).toBe(true);
  });

  it('upserts rather than failing when the same question is answered twice', async () => {
    const h = savingHarness();
    await createQueryStore(h.source, guard).save({ key: KEY_INPUT, query, chart: CHART });
    expect(h.log.some((s) => s.includes('ON CONFLICT (key) DO UPDATE'))).toBe(true);
  });

  it('refuses a ReaderSource', async () => {
    const h = harness();
    const store = createQueryStore(asReaderSource(h.raw) as unknown as AdminSource, guard);
    await expect(store.save({ key: KEY_INPUT, query, chart: CHART })).rejects.toThrow(/asAdminSource/);
    expect(h.log).toEqual([]);
  });

  it('refuses an unsafe metadata schema name at construction', () => {
    const h = harness();
    expect(() => createQueryStore(h.source, guard, { schema: 'a b' })).toThrow(/plain SQL identifier/);
    expect(() => createQueryStore(h.source, guard, { schema: 'x"; DROP SCHEMA public --' })).toThrow(
      /plain SQL identifier/,
    );
  });
});

describe('looking a plan up', () => {
  const hit = (sql = 'SELECT id FROM users', chart = JSON.stringify(CHART)): Harness =>
    harness((text) => (/RETURNING key, question/.test(text) ? rows(CACHED(sql, chart)) : EMPTY));

  it('is a miss, not a throw, when nothing is stored', async () => {
    const h = harness();
    const store = createQueryStore(h.source, guard);
    await expect(store.lookup(KEY_INPUT)).resolves.toBeNull();
    expect(h.log.at(-1)).toBe('COMMIT');
  });

  it('returns a guarded query on a hit', async () => {
    const store = createQueryStore(hit().source, guard);
    const found = await store.lookup(KEY_INPUT);
    expect(found?.sql).toBe(approved('SELECT id FROM users').sql);
    expect(found?.query.rowLimit).toBe(1000);
    expect(found?.chart).toEqual(CHART);
    expect(found?.hitCount).toBe(3);
  });

  it('counts the hit in the same statement that reads the row', async () => {
    const h = hit();
    await createQueryStore(h.source, guard).lookup(KEY_INPUT);
    const read = h.log.find((s) => s.startsWith('UPDATE'));
    expect(read).toContain('hit_count = hit_count + 1');
    expect(read).toContain('expires_at IS NULL OR expires_at > now()');
  });

  it('reads without writing when touchOnHit is off', async () => {
    const h = hit();
    await createQueryStore(h.source, guard, { touchOnHit: false }).lookup(KEY_INPUT);
    expect(h.log.some((s) => s.startsWith('UPDATE'))).toBe(false);
    expect(h.log.some((s) => s.startsWith('SELECT key, question'))).toBe(true);
  });

  it('leaves an expired entry to the database rather than filtering in JavaScript', async () => {
    const h = hit();
    await createQueryStore(h.source, guard).lookup(KEY_INPUT);
    expect(h.log.some((s) => s.includes('expires_at > now()'))).toBe(true);
  });

  it('says to migrate when the table or the whole schema is absent', async () => {
    const absent = [
      new Error('relation "insightkit.approved_query" does not exist'),
      Object.assign(new Error('nope'), { code: '42P01' }),
      Object.assign(new Error('nope'), { code: '3F000' }),
    ];
    for (const err of absent) {
      const h = harness(() => {
        throw err;
      });
      await expect(createQueryStore(h.source, guard).lookup(KEY_INPUT)).rejects.toMatchObject({
        code: 'E_NOT_MIGRATED',
      });
    }
  });

  it('lets an unrelated database error through unchanged', async () => {
    const h = harness(() => {
      throw new Error('canceling statement due to statement timeout');
    });
    await expect(createQueryStore(h.source, guard).lookup(KEY_INPUT)).rejects.toThrow(/timeout/);
  });
});

describe('a restored plan cannot produce unguarded SQL', () => {
  const tampered = (sql: string): Harness =>
    harness((text) => (/RETURNING key, question/.test(text) ? rows(CACHED(sql)) : EMPTY));

  it('re-runs the stored SQL through the guard and misses when it is refused', async () => {
    for (const attack of [
      'DELETE FROM users',
      'SELECT id FROM users; DROP TABLE users',
      'UPDATE users SET email = null',
      "SELECT pg_read_file('/etc/passwd')",
      'not sql at all',
    ]) {
      const h = tampered(attack);
      const seen: RejectedEntry[] = [];
      const store = createQueryStore(h.source, guard, { onRejected: (e) => seen.push(e) });
      await expect(store.lookup(KEY_INPUT)).resolves.toBeNull();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.reason).toBe('denied');
    }
  });

  it('returns the guard’s re-emitted SQL, never the text held in the table', async () => {
    const h = tampered('select   ID   from  users');
    const found = await createQueryStore(h.source, guard).lookup(KEY_INPUT);
    expect(found?.sql).not.toBe('select   ID   from  users');
    expect(found?.sql).toBe(approved('select   ID   from  users').sql);
  });

  it('gives back a query the reader path accepts, carrying the live brand', async () => {
    const found = await createQueryStore(tampered('SELECT id FROM users').source, guard).lookup(KEY_INPUT);
    expect(found).not.toBeNull();
    const { isGuardedQuery } = await import('../src/approve.js');
    expect(isGuardedQuery(found?.query)).toBe(true);
    expect(found?.query.tables.map((t) => t.name)).toEqual(['users']);
  });

  it('re-approves against the policy in force now, not the one in force when it was saved', async () => {
    const h = tampered('SELECT id FROM users');
    const store = createQueryStore(h.source, guard, { policy: { allowedTables: ['orders'] } });
    await expect(store.lookup(KEY_INPUT)).resolves.toBeNull();
  });

  it('treats a tampered chart as a miss rather than handing it on', async () => {
    for (const chart of ['not json', '{"kind":"pie","x":null,"y":[],"series":null,"title":null}', '[]']) {
      const h = harness((text) =>
        /RETURNING key, question/.test(text) ? rows(CACHED('SELECT id FROM users', chart)) : EMPTY,
      );
      const seen: RejectedEntry[] = [];
      const store = createQueryStore(h.source, guard, { onRejected: (e) => seen.push(e) });
      await expect(store.lookup(KEY_INPUT)).resolves.toBeNull();
      expect(seen[0]?.reason).toBe('invalid_chart');
    }
  });

  it('does not let a host logger that throws fail the lookup', async () => {
    const h = tampered('DELETE FROM users');
    const store = createQueryStore(h.source, guard, {
      onRejected: () => {
        throw new Error('logger exploded');
      },
    });
    await expect(store.lookup(KEY_INPUT)).resolves.toBeNull();
  });
});

describe('invalidation', () => {
  const deleting = (count: number): Harness =>
    harness((sql) =>
      sql.startsWith('DELETE FROM') ? rows(Array.from({ length: count }, (_, i) => [`k${i}`])) : EMPTY,
    );

  it('deletes one entry by key input', async () => {
    const h = deleting(1);
    expect(await createQueryStore(h.source, guard).invalidate(KEY_INPUT)).toBe(1);
    const del = h.log.find((s) => s.startsWith('DELETE FROM'));
    expect(del).toContain(`'${cacheKey(KEY_INPUT).key}'`);
    expect(h.log.at(-1)).toBe('COMMIT');
  });

  it('deletes one entry by raw key', async () => {
    const h = deleting(1);
    expect(await createQueryStore(h.source, guard).invalidate('abc123')).toBe(1);
    expect(h.log.some((s) => s.includes("key = 'abc123'"))).toBe(true);
  });

  it('empties the cache and purges expired entries', async () => {
    const all = deleting(4);
    expect(await createQueryStore(all.source, guard).invalidateAll()).toBe(4);

    const stale = deleting(2);
    expect(await createQueryStore(stale.source, guard).purgeExpired()).toBe(2);
    expect(stale.log.some((s) => s.includes('expires_at <= now()'))).toBe(true);
  });

  it('never leaves the metadata schema', async () => {
    const h = deleting(0);
    const store = createQueryStore(h.source, guard);
    await store.invalidateAll();
    await store.purgeExpired();
    for (const s of h.log.filter((x) => x.startsWith('DELETE'))) {
      expect(s).toContain('"insightkit"."approved_query"');
    }
  });
});

describe('the write path as a whole', () => {
  const everyStatement = async (): Promise<string[]> => {
    const log: string[] = [];
    const collect = (h: Harness) => log.push(...h.log);

    const save = savingHarness();
    await createQueryStore(save.source, guard).save({ key: KEY_INPUT, query, chart: CHART });
    collect(save);

    const look = harness();
    await createQueryStore(look.source, guard).lookup(KEY_INPUT);
    collect(look);

    const drop = harness();
    await createQueryStore(drop.source, guard).invalidateAll();
    collect(drop);

    const migrate = harness((sql) => (sql.startsWith('SELECT to_regclass') ? rows([[null]]) : EMPTY));
    await runMigrations(migrate.source);
    collect(migrate);

    return log;
  };

  it('contains no bare SET: every setting is SET LOCAL', async () => {
    for (const s of await everyStatement()) {
      if (/^SET\b/i.test(s)) expect(s).toMatch(/^SET LOCAL /);
    }
  });

  it('never names a schema other than the configured one', async () => {
    for (const s of await everyStatement()) {
      if (/^(INSERT|UPDATE|DELETE|SELECT|CREATE)/.test(s)) {
        expect(s.includes('"insightkit"')).toBe(true);
      }
    }
  });

  it('opens and closes every transaction it opens', async () => {
    const log = await everyStatement();
    const opened = log.filter((s) => s === 'BEGIN').length;
    const closed = log.filter((s) => s === 'COMMIT' || s === 'ROLLBACK').length;
    expect(opened).toBe(closed);
    expect(opened).toBeGreaterThan(0);
  });

  it('quotes every caller-controlled field instead of letting one become a statement', async () => {
    const hostile = "x' ; DROP TABLE public.users ; SELECT '";
    const h = savingHarness();
    const store = createQueryStore(h.source, guard, { onRejected: () => undefined });
    await store.save({
      key: {
        question: hostile,
        tables: [table(USERS.schema, USERS.name, [col('id')], { comment: hostile })],
        plannerVersion: hostile,
        guidance: hostile,
      },
      query,
      chart: { ...CHART, title: hostile },
      tenantId: hostile,
    });

    // Strip the quoted literals; nothing hostile may survive outside them.
    for (const statement of h.log) {
      expect(statement.replace(/'(?:[^']|'')*'/g, "''")).not.toContain('DROP TABLE');
    }
    expect(h.log.filter((s) => /^(INSERT|SELECT|UPDATE|DELETE)/.test(s))).toHaveLength(1);
  });
});

describe('StoreError', () => {
  it('carries a code a caller can branch on', () => {
    const err = new StoreError('E_NOT_MIGRATED', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StoreError');
    expect(err.code).toBe('E_NOT_MIGRATED');
  });
});
