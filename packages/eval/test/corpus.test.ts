import { readFileSync } from 'node:fs';
import type { Guard } from '@insightkit/sql-guard';
import { createGuard } from '@insightkit/sql-guard';
import { loadModule, parseSync } from 'pgsql-parser';
import { beforeAll, describe, expect, it } from 'vitest';
import { astEquivalent } from '../src/fidelity.js';
import type { AdversarialCase, GoldenCase } from '../src/types.js';

const read = (name: string): string => readFileSync(new URL(`../corpus/${name}`, import.meta.url), 'utf8');

const golden: GoldenCase[] = JSON.parse(read('golden.json'));
const adversarial: AdversarialCase[] = JSON.parse(read('adversarial.json'));
const schema = read('schema.sql');

const SCHEMA_TABLES = new Set([...schema.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1] ?? ''));

const cteNames = (node: unknown, found: Set<string> = new Set<string>()): Set<string> => {
  if (Array.isArray(node)) {
    for (const child of node) cteNames(child, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'ctename' && typeof value === 'string') found.add(value);
    cteNames(value, found);
  }
  return found;
};

const MIN_T1 = 8;
const MIN_T2 = 12;
const MIN_T3 = 5;
const MIN_GUARD_SURFACE = 9;

const withSql = golden.filter((c): c is GoldenCase & { sql: string } => c.sql !== null);

const MAX_ROWS = 1000;

let guard: Guard;
let capped: Guard;
beforeAll(async () => {
  await loadModule();
  guard = await createGuard({ allowedSchemas: ['public'] });
  capped = await createGuard({ allowedSchemas: ['public'], maxRows: MAX_ROWS });
});

describe('corpus integrity', () => {
  it('has no duplicate ids', () => {
    const ids = [...golden.map((c) => c.id), ...adversarial.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps at least the tier sizes the gate was calibrated against', () => {
    expect(golden.filter((c) => c.tier === 'T1').length).toBeGreaterThanOrEqual(MIN_T1);
    expect(golden.filter((c) => c.tier === 'T2').length).toBeGreaterThanOrEqual(MIN_T2);
    expect(golden.filter((c) => c.tier === 'T3').length).toBeGreaterThanOrEqual(MIN_T3);
    expect(adversarial.filter((c) => c.surface === 'guard').length).toBeGreaterThanOrEqual(MIN_GUARD_SURFACE);
  });

  it('gives every scored question a reference query and every ambiguity question none', () => {
    for (const c of golden) {
      if (c.tier === 'T3') expect(c.sql, c.id).toBeNull();
      else expect(c.sql, c.id).not.toBeNull();
    }
  });

  it('declares what each case tests', () => {
    for (const c of golden) expect(c.tests.length, c.id).toBeGreaterThan(20);
  });

  it('references only tables that exist in the reference schema', () => {
    expect(SCHEMA_TABLES.size).toBe(8);
    for (const c of withSql) {
      const v = guard(c.sql);
      if (!v.ok) continue;
      const ctes = cteNames(parseSync(c.sql));
      for (const t of v.tables) {
        if (t.schema === null && !SCHEMA_TABLES.has(t.name) && !ctes.has(t.name)) {
          throw new Error(`${c.id} references unknown table ${t.name}`);
        }
      }
    }
  });
});

describe('every reference query is one the shipped guard accepts', () => {
  for (const c of withSql) {
    it(`${c.id} ${c.prompt}`, () => {
      const v = guard(c.sql);
      if (!v.ok) throw new Error(`guard denied a legitimate analyst query: ${v.code} ${v.detail}`);
    });
  }
});

describe('deparsing a reference query preserves its meaning', () => {
  for (const c of withSql) {
    it(`${c.id} round-trips to an equivalent tree`, () => {
      const v = guard(c.sql);
      expect(v.ok, c.id).toBe(true);
      if (!v.ok) return;
      const r = astEquivalent(parseSync(c.sql), parseSync(v.sql));
      expect(
        r.unknownPositional,
        'unrecognised positional field; review before adding to the allowlist',
      ).toEqual([]);
      if (!r.equal) throw new Error(`deparse changed the query\n  in : ${c.sql}\n  out: ${v.sql}`);
    });
  }
});

describe('adversarial cases the guard refuses outright', () => {
  for (const c of adversarial.filter((a) => a.expect === 'blocked')) {
    it(`${c.id} ${c.prompt}`, () => {
      expect(c.sql, `${c.id} must carry the SQL it is asserting about`).not.toBeNull();
      const v = guard(c.sql ?? '');
      expect(v.ok, `${c.id} was ALLOWED: ${c.why}`).toBe(false);
      if (!v.ok) expect(v.code, c.id).toBe(c.expectCode);
    });
  }
});

describe('adversarial cases the guard neutralises rather than refuses', () => {
  for (const c of adversarial.filter((a) => a.expect === 'neutralised')) {
    it(`${c.id} ${c.prompt}`, () => {
      const v = capped(c.sql ?? '');
      expect(v.ok, `${c.id} was denied; it is expected to be allowed but made safe`).toBe(true);
      if (!v.ok) return;
      expect(v.rowLimit, `${c.id} carries no row limit`).toBe(MAX_ROWS);
      expect(v.sql, `${c.id}: the cap must be in the emitted sql, not only in the verdict`).toMatch(
        new RegExp(`LIMIT ${MAX_ROWS}\\b`),
      );
    });
  }
});

describe('adversarial cases nothing handles yet', () => {
  it('keeps every case consistent about what handles it', () => {
    for (const c of adversarial) {
      if (c.expect === 'blocked') {
        expect(c.handledBy, c.id).toBeNull();
        expect(c.expectCode, c.id).not.toBeNull();
      } else {
        expect(c.handledBy, `${c.id} must name the component that handles it`).not.toBeNull();
        expect(c.expectCode, c.id).toBeNull();
      }
    }
  });

  for (const c of adversarial.filter((a) => a.expect === 'unhandled' && a.sql !== null)) {
    it(`${c.id} is still unhandled, pending ${c.handledBy}`, () => {
      const v = capped(c.sql ?? '');
      expect(
        v.ok,
        `${c.id} is now blocked. Good news: change expect to blocked or neutralised and record that ${c.handledBy} landed.`,
      ).toBe(true);
    });
  }
});
