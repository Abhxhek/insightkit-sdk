import type { Guard } from '@insightkit/sql-guard';
import { createGuard } from '@insightkit/sql-guard';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { approve } from '../src/approve.js';
import { runGuardedRead } from '../src/execute.js';
import type { PgClient, PgPool, PgQueryConfig } from '../src/pg.js';
import { FIDELITY_TYPES, fromPgPool } from '../src/pg.js';
import { asReaderSource } from '../src/source.js';

interface ResultShape {
  addFields(fields: { name: string; dataTypeID: number; format: string }[]): void;
  parseRow(raw: (string | null)[]): unknown[];
}
const ResultCtor = (pg as unknown as { Result: new (rowMode: string, types: unknown) => ResultShape }).Result;

interface Column {
  readonly name: string;
  readonly oid: number;
}

/** Parses through node-postgres' own Result, so these assert the driver, not a model of it. */
function fakePool(columns: readonly Column[], raw: readonly (string | null)[][]) {
  const seen: PgQueryConfig[] = [];
  const releases: boolean[] = [];
  const client: PgClient = {
    async query(config) {
      seen.push(config);
      const fields = columns.map((c) => ({ name: c.name, dataTypeID: c.oid, format: 'text' }));
      const result = new ResultCtor('array', config.types);
      result.addFields(fields);
      return { fields, rows: raw.map((row) => result.parseRow([...row])) };
    },
    release(destroy) {
      releases.push(destroy === true);
    },
  };
  const pool: PgPool = { connect: async () => client, options: { connectionTimeoutMillis: 5000 } };
  return { pool, seen, releases };
}

const one = async (columns: readonly Column[], raw: readonly (string | null)[][]) => {
  const f = fakePool(columns, raw);
  const client = await fromPgPool(f.pool).connect();
  return { ...f, outcome: await client.query('SELECT 1'), client };
};

describe('how the adapter asks for rows', () => {
  it('always requests array rows, so duplicate column names cannot collapse', async () => {
    const { seen } = await one([{ name: 'id', oid: 23 }], [['1']]);
    expect(seen[0]?.rowMode).toBe('array');
  });

  it('supplies its own type registry instead of mutating the global one', async () => {
    const { seen } = await one([{ name: 'id', oid: 23 }], [['1']]);
    expect(seen[0]?.types).toBe(FIDELITY_TYPES);
    expect(pg.types.getTypeParser(1082)('2026-09-05')).toBeInstanceOf(Date);
  });

  it('reports column names in order', async () => {
    const { outcome } = await one(
      [
        { name: 'a', oid: 23 },
        { name: 'b', oid: 25 },
      ],
      [['1', 'x']],
    );
    expect(outcome.fields.map((f) => f.name)).toEqual(['a', 'b']);
  });
});

describe('values that node-postgres would corrupt on the way to a chart', () => {
  it('keeps a date on the day Postgres said, regardless of server timezone', async () => {
    const { outcome } = await one([{ name: 'day', oid: 1082 }], [['2026-09-05']]);
    expect(outcome.rows[0]?.[0]).toBe('2026-09-05');
    expect(JSON.parse(JSON.stringify(outcome.rows))[0][0]).toBe('2026-09-05');
  });

  it('does not invent a timezone for a timestamp that never had one', async () => {
    const { outcome } = await one([{ name: 'at', oid: 1114 }], [['2026-09-05 13:45:00']]);
    expect(outcome.rows[0]?.[0]).toBe('2026-09-05 13:45:00');
  });

  it('keeps the offset a timestamptz carried', async () => {
    const { outcome } = await one([{ name: 'at', oid: 1184 }], [['2026-09-05 13:45:00+00']]);
    expect(outcome.rows[0]?.[0]).toBe('2026-09-05 13:45:00+00');
  });

  it('keeps numeric[] exact, which the driver array parser does not', async () => {
    const { outcome } = await one([{ name: 'n', oid: 1231 }], [['{0.30000000000000004,2.5}']]);
    expect(outcome.rows[0]?.[0]).toBe('{0.30000000000000004,2.5}');
  });

  it('keeps dates inside an array off the Date path', async () => {
    const { outcome } = await one([{ name: 'days', oid: 1182 }], [['{2026-09-05}']]);
    expect(String(outcome.rows[0]?.[0])).not.toContain('T');
  });

  it('returns bytea as the hex Postgres sent rather than a Buffer', async () => {
    const { outcome } = await one([{ name: 'b', oid: 17 }], [['\\x4142']]);
    expect(outcome.rows[0]?.[0]).toBe('\\x4142');
  });
});

describe('values the driver already gets right are left alone', () => {
  it('keeps integers as numbers', async () => {
    const { outcome } = await one([{ name: 'n', oid: 23 }], [['42']]);
    expect(outcome.rows[0]?.[0]).toBe(42);
  });

  it('keeps bigint and numeric as strings so precision survives', async () => {
    const { outcome } = await one(
      [
        { name: 'big', oid: 20 },
        { name: 'dec', oid: 1700 },
      ],
      [['9007199254740993', '12345678901234567890.12']],
    );
    expect(outcome.rows[0]).toEqual(['9007199254740993', '12345678901234567890.12']);
  });

  it('keeps booleans, json and arrays usable', async () => {
    const { outcome } = await one(
      [
        { name: 'ok', oid: 16 },
        { name: 'doc', oid: 3802 },
        { name: 'xs', oid: 1007 },
      ],
      [['t', '{"a":1}', '{1,2}']],
    );
    expect(outcome.rows[0]).toEqual([true, { a: 1 }, [1, 2]]);
  });

  it('passes NULL through as null', async () => {
    const { outcome } = await one([{ name: 'day', oid: 1082 }], [[null]]);
    expect(outcome.rows[0]?.[0]).toBeNull();
  });
});

describe('connection handling', () => {
  it('returns the connection to the pool by default', async () => {
    const f = await one([{ name: 'id', oid: 23 }], [['1']]);
    f.client.release();
    expect(f.releases).toEqual([false]);
  });

  it('destroys the connection when asked', async () => {
    const f = await one([{ name: 'id', oid: 23 }], [['1']]);
    f.client.release(true);
    expect(f.releases).toEqual([true]);
  });

  it('swallows a second release rather than letting pg throw over the real error', async () => {
    const f = await one([{ name: 'id', oid: 23 }], [['1']]);
    f.client.release();
    expect(() => f.client.release(true)).not.toThrow();
    expect(f.releases).toEqual([false]);
  });

  it('refuses anything that is not a pool', () => {
    expect(() => fromPgPool(null as unknown as PgPool)).toThrow(/node-postgres Pool/);
    expect(() => fromPgPool({} as unknown as PgPool)).toThrow(/node-postgres Pool/);
  });

  it('refuses a pool that would wait forever for a connection', () => {
    const nope = { connect: async () => ({}) as PgClient, options: {} };
    expect(() => fromPgPool(nope)).toThrow(/connectionTimeoutMillis/);
    expect(() => fromPgPool({ ...nope, options: { connectionTimeoutMillis: 0 } })).toThrow(
      /connectionTimeoutMillis/,
    );
  });

  it('accepts a real pg.Pool', async () => {
    const real = new pg.Pool({ connectionTimeoutMillis: 5000 });
    expect(() => fromPgPool(real)).not.toThrow();
    await real.end();
  });
});

describe('through the whole reader path', () => {
  let guard: Guard;
  beforeAll(async () => {
    guard = await createGuard({ maxRows: 1000 });
  });

  it('runs a guarded query against a pg pool inside the sealed transaction', async () => {
    const seen: string[] = [];
    const client: PgClient = {
      async query(config) {
        seen.push(config.text);
        const fields =
          config.text === 'SHOW transaction_read_only'
            ? [{ name: 'transaction_read_only', dataTypeID: 25, format: 'text' }]
            : [{ name: 'day', dataTypeID: 1082, format: 'text' }];
        const rows =
          config.text === 'SHOW transaction_read_only'
            ? [['on']]
            : config.text.startsWith('SELECT')
              ? [['2026-09-05']]
              : [];
        return { fields, rows };
      },
      release() {},
    };
    const pool: PgPool = { connect: async () => client, options: { connectionTimeoutMillis: 5000 } };
    const approval = approve(guard, 'SELECT created_on FROM signups');
    if (!approval.ok) throw new Error('fixture should be approved');

    const result = await runGuardedRead(asReaderSource(fromPgPool(pool)), approval.query);

    expect(seen[0]).toBe('BEGIN READ ONLY');
    expect(seen.at(-1)).toBe('ROLLBACK');
    expect(seen.some((s) => /commit/i.test(s))).toBe(false);
    expect(result.rows.columns).toEqual(['day']);
    expect(result.rows.rows[0]?.[0]).toBe('2026-09-05');
  });
});
