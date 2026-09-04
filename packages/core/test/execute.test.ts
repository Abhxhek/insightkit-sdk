import type { Guard } from '@insightkit/sql-guard';
import { createGuard } from '@insightkit/sql-guard';
import { beforeAll, describe, expect, it } from 'vitest';
import { approve } from '../src/approve.js';
import { runGuardedRead, sessionPreamble } from '../src/execute.js';
import { asAdminSource, asReaderSource } from '../src/source.js';
import type { GuardedQuery, QueryOutcome, SqlClient } from '../src/types.js';

const READ_ONLY_ON: QueryOutcome = { fields: [{ name: 'transaction_read_only' }], rows: [['on']] };
const EMPTY: QueryOutcome = { fields: [], rows: [] };

interface Harness {
  readonly log: string[];
  readonly released: boolean[];
  readonly source: ReturnType<typeof asReaderSource>;
}

function harness(handler?: (sql: string) => QueryOutcome | Promise<QueryOutcome>): Harness {
  const log: string[] = [];
  const released: boolean[] = [];
  const client: SqlClient = {
    async query(text) {
      log.push(text);
      if (handler) return await handler(text);
      return text === 'SHOW transaction_read_only' ? READ_ONLY_ON : EMPTY;
    },
    release(destroy) {
      released.push(destroy === true);
    },
  };
  return { log, released, source: asReaderSource({ connect: async () => client }) };
}

let guard: Guard;
let query: GuardedQuery;

beforeAll(async () => {
  guard = await createGuard({ maxRows: 1000 });
  const approval = approve(guard, 'SELECT id FROM users');
  if (!approval.ok) throw new Error('fixture query should be approved');
  query = approval.query;
});

describe('the sealed read-only transaction', () => {
  it('opens with BEGIN READ ONLY before anything else', async () => {
    const h = harness();
    await runGuardedRead(h.source, query);
    expect(h.log[0]).toBe('BEGIN READ ONLY');
  });

  it('never issues COMMIT, even when everything succeeds', async () => {
    const h = harness();
    await runGuardedRead(h.source, query);
    expect(h.log.some((s) => /commit/i.test(s))).toBe(false);
    expect(h.log.at(-1)).toBe('ROLLBACK');
  });

  it('scopes every setting to the transaction so nothing leaks across a pooled connection', async () => {
    const h = harness();
    await runGuardedRead(h.source, query);
    const settings = h.log.filter((s) => s.startsWith('SET'));
    expect(settings.length).toBeGreaterThan(0);
    for (const s of settings) expect(s).toMatch(/^SET LOCAL /);
  });

  it('asks the server to confirm the transaction is read only', async () => {
    const h = harness();
    await runGuardedRead(h.source, query);
    expect(h.log).toContain('SHOW transaction_read_only');
  });

  it('aborts when the server does not report a read-only transaction', async () => {
    const h = harness((sql) =>
      sql === 'SHOW transaction_read_only'
        ? { fields: [{ name: 'transaction_read_only' }], rows: [['off']] }
        : EMPTY,
    );
    await expect(runGuardedRead(h.source, query)).rejects.toThrow(/not report this transaction as read only/);
    expect(h.log.at(-1)).toBe('ROLLBACK');
  });

  it('rolls back and releases even when the query itself fails', async () => {
    const h = harness((sql) => {
      if (sql === 'SHOW transaction_read_only') return READ_ONLY_ON;
      if (sql.startsWith('SELECT id')) throw new Error('relation does not exist');
      return EMPTY;
    });
    await expect(runGuardedRead(h.source, query)).rejects.toThrow(/relation does not exist/);
    expect(h.log.at(-1)).toBe('ROLLBACK');
    expect(h.released).toHaveLength(1);
  });

  it('discards the connection when the rollback itself fails', async () => {
    const h = harness((sql) => {
      if (sql === 'ROLLBACK') throw new Error('connection reset');
      if (sql === 'SHOW transaction_read_only') return READ_ONLY_ON;
      return EMPTY;
    });
    await runGuardedRead(h.source, query);
    expect(h.released).toEqual([true]);
  });

  it('returns the connection to the pool on a clean run', async () => {
    const h = harness();
    await runGuardedRead(h.source, query);
    expect(h.released).toEqual([false]);
  });

  it('executes the deparsed sql from the verdict, not the caller string', async () => {
    const h = harness();
    await runGuardedRead(h.source, query);
    expect(h.log).toContain(query.sql);
    expect(query.sql).toMatch(/LIMIT 1000/);
  });

  it('reports reaching the row limit', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => [i]);
    const h = harness((sql) =>
      sql === 'SHOW transaction_read_only' ? READ_ONLY_ON : { fields: [{ name: 'id' }], rows },
    );
    const result = await runGuardedRead(h.source, query);
    expect(result.reachedLimit).toBe(true);
    expect(result.rowLimit).toBe(1000);
  });

  it('does not claim truncation when fewer rows came back', async () => {
    const h = harness((sql) =>
      sql === 'SHOW transaction_read_only' ? READ_ONLY_ON : { fields: [{ name: 'id' }], rows: [[1], [2]] },
    );
    expect((await runGuardedRead(h.source, query)).reachedLimit).toBe(false);
  });
});

describe('what runGuardedRead refuses to be handed', () => {
  it('refuses a source that was never blessed as a reader', async () => {
    const raw = { connect: async () => ({ query: async () => EMPTY, release: () => {} }) };
    await expect(runGuardedRead(raw as never, query)).rejects.toThrow(/asReaderSource/);
  });

  it('refuses an admin source even though it has the same shape', async () => {
    const admin = asAdminSource({ connect: async () => ({ query: async () => EMPTY, release: () => {} }) });
    await expect(runGuardedRead(admin as never, query)).rejects.toThrow(/asReaderSource/);
  });

  it('refuses a hand-built query object that never went through the guard', async () => {
    const h = harness();
    const forged = { sql: 'DELETE FROM users', tables: [], rowLimit: null } as unknown as GuardedQuery;
    await expect(runGuardedRead(h.source, forged)).rejects.toThrow(/produced by approve/);
    expect(h.log).toEqual([]);
  });

  it('refuses a forged query even when it copies every visible field', async () => {
    const h = harness();
    const forged = { ...query, sql: 'DELETE FROM users' } as GuardedQuery;
    await expect(runGuardedRead(h.source, forged)).rejects.toThrow(/produced by approve/);
  });
});

describe('sessionPreamble', () => {
  it('excludes pg_temp from the search path', () => {
    const path = sessionPreamble().find((s) => s.includes('search_path'));
    expect(path).toBeDefined();
    expect(path).not.toMatch(/pg_temp/);
  });

  it('turns row security on', () => {
    expect(sessionPreamble()).toContain('SET LOCAL row_security = on');
  });

  it('sets all three timeouts', () => {
    const text = sessionPreamble().join('\n');
    expect(text).toMatch(/statement_timeout/);
    expect(text).toMatch(/lock_timeout/);
    expect(text).toMatch(/idle_in_transaction_session_timeout/);
  });

  it('quotes schema identifiers', () => {
    const path = sessionPreamble({ searchPath: ['reporting'] }).find((s) => s.includes('search_path'));
    expect(path).toBe('SET LOCAL search_path = "reporting"');
  });

  it('refuses a schema name that is not a plain identifier', () => {
    expect(() => sessionPreamble({ searchPath: ['public"; DROP TABLE users --'] })).toThrow(
      /unsafe identifier/,
    );
    expect(() => sessionPreamble({ searchPath: ['public, pg_temp'] })).toThrow(/unsafe identifier/);
  });

  it('refuses an empty search path rather than defaulting silently', () => {
    expect(() => sessionPreamble({ searchPath: [] })).toThrow(/at least one schema/);
  });

  it('refuses a timeout that is not a sane integer', () => {
    expect(() => sessionPreamble({ statementTimeoutMs: 0 })).toThrow(/statementTimeoutMs/);
    expect(() => sessionPreamble({ statementTimeoutMs: -1 })).toThrow(/statementTimeoutMs/);
    expect(() => sessionPreamble({ statementTimeoutMs: 1.5 })).toThrow(/statementTimeoutMs/);
    expect(() => sessionPreamble({ lockTimeoutMs: 10 ** 9 })).toThrow(/lockTimeoutMs/);
  });
});

describe('approve', () => {
  it('refuses to produce a query from SQL the guard denies', () => {
    const a = approve(guard, 'DELETE FROM users');
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe('E_NOT_SELECT');
  });

  it('carries the deparsed sql rather than the input', () => {
    const a = approve(guard, 'select   id   from users');
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.query.sql).not.toBe('select   id   from users');
  });
});
