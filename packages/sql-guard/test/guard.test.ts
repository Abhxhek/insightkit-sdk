import { beforeAll, describe, expect, it } from 'vitest';
import { createGuard } from '../src/index.js';
import type { Guard } from '../src/types.js';
import attacks from './corpus/attacks.json' with { type: 'json' };
import legitimate from './corpus/legitimate.json' with { type: 'json' };

const MIN_ATTACK_CASES = 58;
const MIN_LEGITIMATE_CASES = 28;

let guard: Guard;
beforeAll(async () => {
  guard = await createGuard();
});

describe('corpus size gate', () => {
  it('retains at least the recorded number of attack cases', () => {
    expect(attacks.length).toBeGreaterThanOrEqual(MIN_ATTACK_CASES);
  });

  it('retains at least the recorded number of legitimate cases', () => {
    expect(legitimate.length).toBeGreaterThanOrEqual(MIN_LEGITIMATE_CASES);
  });

  it('has no duplicate ids', () => {
    const ids = [...attacks, ...legitimate].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('adversarial corpus — every case must be denied', () => {
  for (const c of attacks) {
    it(`${c.id}: ${c.why}`, () => {
      const v = guard(c.sql);
      expect(v.ok, `ALLOWED but must be denied: ${c.sql}`).toBe(false);
    });
  }
});

describe('legitimate corpus — every case must be allowed', () => {
  for (const c of legitimate) {
    it(`${c.id}`, () => {
      const v = guard(c.sql);
      expect(v.ok ? null : `${v.code}: ${v.detail}`).toBeNull();
    });
  }
});

describe('verdict contract', () => {
  it('never throws on hostile input', () => {
    const inputs = [
      '',
      '   ',
      'SELECT',
      ')',
      "'",
      '\u0000',
      'SELECT\u0000 1',
      'SELECT 1\u0000; DROP TABLE users',
      'SELECT '.repeat(5000),
      `SELECT ${'('.repeat(500)}1${')'.repeat(500)}`,
    ];
    for (const sql of inputs) expect(() => guard(sql)).not.toThrow();
  });

  it('never throws on non-string input', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(() => guard(bad as unknown as string)).not.toThrow();
      expect(guard(bad as unknown as string).ok).toBe(false);
    }
  });

  it('collapses redundant parentheses rather than counting them as depth', () => {
    const parens = `SELECT ${'('.repeat(400)}1${')'.repeat(400)}`;
    expect(guard(parens).ok).toBe(true);
  });

  it('rejects genuine deep nesting rather than overflowing the stack', () => {
    const deep = `SELECT ${'abs('.repeat(300)}1${')'.repeat(300)}`;
    const v = guard(deep);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('E_DEPTH_EXCEEDED');
  });

  it('admits a realistically complex dashboard query', () => {
    const hairy = `WITH a AS (SELECT date_trunc('week', ts) w, count(*) c FROM e GROUP BY 1),
      b AS (SELECT w, c, lag(c) OVER (ORDER BY w) p FROM a),
      d AS (SELECT w, c, p, CASE WHEN p IS NULL OR p = 0 THEN NULL
            ELSE round(((c - p)::numeric / p) * 100, 2) END g FROM b)
      SELECT d.w, d.c, d.g FROM d JOIN (SELECT max(w) mw FROM d) m ON d.w <= m.mw
      WHERE d.g IS NOT NULL AND d.w BETWEEN $1 AND $2 ORDER BY d.w DESC LIMIT 100`;
    const v = guard(hairy);
    expect(v.ok ? null : `${v.code}: ${v.detail}`).toBeNull();
  });

  it('returns sql re-emitted from the validated tree, not the caller string', () => {
    const v = guard('select    COUNT(*)   from    users');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.sql).not.toBe('select    COUNT(*)   from    users');
      expect(v.sql).toContain('count(*)');
    }
  });

  it('reports referenced tables', () => {
    const v = guard('SELECT u.id FROM public.users u JOIN plans p ON p.user_id = u.id');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.tables).toContainEqual({ schema: 'public', name: 'users' });
      expect(v.tables).toContainEqual({ schema: null, name: 'plans' });
    }
  });
});

describe('policy', () => {
  it('denies tables outside allowedTables', () => {
    const v = guard('SELECT * FROM secrets', { allowedTables: ['users'] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('E_TABLE_NOT_ALLOWED');
  });

  it('allows tables inside allowedTables', () => {
    expect(guard('SELECT id FROM users', { allowedTables: ['users'] }).ok).toBe(true);
  });

  it('does not mistake a CTE name for a disallowed table', () => {
    const sql = 'WITH recent AS (SELECT id FROM users) SELECT * FROM recent';
    expect(guard(sql, { allowedTables: ['users'] }).ok).toBe(true);
  });

  it('denies schemas outside allowedSchemas', () => {
    const v = guard('SELECT * FROM internal.audit', { allowedSchemas: ['public'] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('E_SCHEMA_NOT_ALLOWED');
  });

  it('blocks reads of the insightkit metadata schema when scoped to public', () => {
    const v = guard('SELECT * FROM insightkit.sessions', { allowedSchemas: ['public'] });
    expect(v.ok).toBe(false);
  });
});

describe('repository hygiene', () => {
  it('no source file contains a raw NUL byte', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const packages = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const offenders: string[] = [];
    for (const pkg of await readdir(packages, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      for (const root of ['src', 'test', 'corpus']) {
        const base = join(packages, pkg.name, root);
        const entries = await readdir(base, { recursive: true, withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (!e.isFile()) continue;
          const buf = await readFile(join(e.parentPath ?? base, e.name));
          if (buf.includes(0)) offenders.push(`${pkg.name}/${root}/${e.name}`);
        }
      }
    }
    expect(
      offenders,
      'a raw NUL makes git treat the file as binary, so it produces no reviewable diff',
    ).toEqual([]);
  });
});

describe('deny codes are specific', () => {
  const expected: Array<[string, string]> = [
    ['DELETE FROM users', 'E_NOT_SELECT'],
    ['SELECT 1; DROP TABLE users', 'E_MULTI_STATEMENT'],
    ['SELECT * INTO exfil FROM users', 'E_FIELD_NOT_ALLOWED'],
    ['SELECT * FROM users FOR UPDATE', 'E_FIELD_NOT_ALLOWED'],
    ["SELECT pg_read_file('/etc/passwd')", 'E_FUNCTION_NOT_ALLOWED'],
    ['WITH g AS (DELETE FROM users RETURNING *) SELECT * FROM g', 'E_NODE_NOT_ALLOWED'],
    ['SELEKT 1', 'E_PARSE'],
    ['', 'E_EMPTY'],
    ['SELECT 1\u0000; DROP TABLE users', 'E_NUL_BYTE'],
  ];
  for (const [sql, code] of expected) {
    it(`${code} for: ${sql.slice(0, 45)}`, () => {
      const v = guard(sql);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe(code);
    });
  }
});
