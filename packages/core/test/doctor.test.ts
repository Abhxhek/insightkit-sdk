import { loadModule, parse } from 'pgsql-parser';
import { describe, expect, it } from 'vitest';
import { isolationChecks } from '../src/doctor/checks.js';
import { proveIsolation } from '../src/doctor/run.js';
import type { Check, QueryOutcome, SqlClient } from '../src/types.js';

const ROLES = { reader: 'ik_reader', login: 'ik_sdk', metadataSchema: 'insightkit' };
const checks = isolationChecks(ROLES);
const scopedChecks = isolationChecks({ ...ROLES, tenantScoping: true });

const pick = (from: readonly Check[], id: string): Check => {
  const c = from.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check ${id}`);
  return c;
};
const byId = (id: string): Check => pick(checks, id);
const scoped = (id: string): Check => pick(scopedChecks, id);

const outcome = (rows: unknown[][]): QueryOutcome => ({ fields: [], rows });

function source(answers: Record<string, unknown[][]>, failOn?: string) {
  const log: string[] = [];
  const released: boolean[] = [];
  const client: SqlClient = {
    async query(text) {
      log.push(text);
      if (failOn !== undefined && text.includes(failOn)) throw new Error('permission denied for relation');
      const hit = Object.entries(answers).find(([needle]) => text.includes(needle));
      return outcome(hit?.[1] ?? []);
    },
    release(destroy) {
      released.push(destroy === true);
    },
  };
  return { connect: async () => client, log, released };
}

describe('individual checks', () => {
  it('A0 fails when the proof is run as the role under test', () => {
    expect(byId('A0').evaluate([['ik_sdk']]).status).toBe('fail');
    expect(byId('A0').evaluate([['postgres']]).status).toBe('pass');
  });

  it('A1 fails on any non-SELECT privilege', () => {
    expect(byId('A1').evaluate([]).status).toBe('pass');
    const bad = byId('A1').evaluate([['public', 'users', 'UPDATE']]);
    expect(bad.status).toBe('fail');
    expect(bad.detail).toContain('users');
  });

  it('A2 fails on any pg_ role membership', () => {
    expect(byId('A2').evaluate([]).status).toBe('pass');
    expect(byId('A2').evaluate([['pg_read_all_data']]).status).toBe('fail');
  });

  it('A3 fails when a role carries a dangerous attribute', () => {
    const clean = [
      ['ik_reader', false, false, false, false, false],
      ['ik_sdk', false, false, false, false, false],
    ];
    expect(byId('A3').evaluate(clean).status).toBe('pass');
    const bypass = [['ik_sdk', false, false, false, false, true]];
    expect(byId('A3').evaluate(bypass).status).toBe('fail');
  });

  it('A3 fails when the roles do not exist at all', () => {
    expect(byId('A3').evaluate([]).status).toBe('fail');
  });

  it('A4 fails when the reader can reach the metadata schema', () => {
    expect(byId('A4').evaluate([[false]]).status).toBe('pass');
    expect(byId('A4').evaluate([[true]]).status).toBe('fail');
  });

  it('B checks report for review rather than blocking', () => {
    expect(byId('B1').evaluate([['public', 'do_thing', 'postgres']]).status).toBe('review');
    expect(byId('B2').evaluate([['public', 'user_summary']]).status).toBe('review');
    expect(byId('B3').evaluate([['dblink']]).status).toBe('review');
    for (const id of ['B1', 'B2', 'B3']) expect(byId(id).blocking).toBe(false);
  });

  it('marks every A check as blocking', () => {
    for (const c of checks.filter((x) => x.id.startsWith('A'))) expect(c.blocking).toBe(true);
  });

  it('A3 already covers BYPASSRLS, so no separate check duplicates it', () => {
    expect(byId('A3').sql).toContain('rolbypassrls');
    expect(byId('A3').evaluate([['ik_reader', false, false, false, false, true]]).status).toBe('fail');
    expect(checks.filter((c) => c.sql.includes('rolbypassrls'))).toHaveLength(1);
  });

  it('T1 fails when a table the reader can read has row security off', () => {
    const mixed = [
      ['public', 'users', true],
      ['public', 'orders', false],
    ];
    const bad = scoped('T1').evaluate(mixed);
    expect(bad.status).toBe('fail');
    expect(bad.detail).toContain('orders');
    expect(scoped('T1').evaluate([['public', 'users', true]]).status).toBe('pass');
  });

  it('T1 does not pass vacuously when the reader can read nothing', () => {
    const empty = scoped('T1').evaluate([]);
    expect(empty.status).toBe('fail');
    expect(empty.detail).toContain('unproven');
  });

  it('T1 reports for review instead of failing when tenant scoping is not configured', () => {
    expect(byId('T1').blocking).toBe(false);
    expect(byId('T1').evaluate([['public', 'users', false]]).status).toBe('review');
    expect(scoped('T1').blocking).toBe(true);
  });

  it('T2 fails only where the reader owns a table that does not force row security', () => {
    expect(scoped('T2').evaluate([]).status).toBe('pass');
    const owned = scoped('T2').evaluate([['public', 'users', 'ik_sdk']]);
    expect(owned.status).toBe('fail');
    expect(owned.detail).toContain('FORCE ROW LEVEL SECURITY');
    expect(scoped('T2').sql).toContain('relforcerowsecurity');
  });

  it('T3 and T4 report for review and never block, whatever the scoping flag', () => {
    expect(scoped('T3').evaluate([['public', 'users']]).status).toBe('review');
    expect(scoped('T4').evaluate([['public', 'users', 'everything']]).status).toBe('review');
    for (const id of ['T3', 'T4']) {
      expect(byId(id).blocking).toBe(false);
      expect(scoped(id).blocking).toBe(false);
    }
    expect(scoped('T3').evaluate([]).status).toBe('pass');
    expect(scoped('T4').evaluate([]).status).toBe('pass');
  });

  it('refuses to build checks around a role name that is not an identifier', () => {
    expect(() => isolationChecks({ ...ROLES, login: "x'; DROP TABLE users --" })).toThrow(
      /plain SQL identifier/,
    );
    expect(() => isolationChecks({ ...ROLES, metadataSchema: 'a b' })).toThrow(/plain SQL identifier/);
  });
});

describe('the row security checks', () => {
  it('are each a single well-formed postgres statement', async () => {
    await loadModule();
    for (const c of scopedChecks.filter((x) => x.id.startsWith('T'))) {
      expect((await parse(c.sql)).stmts, c.id).toHaveLength(1);
    }
  });

  it('read the catalog columns they claim to', () => {
    expect(scoped('T1').sql).toContain('relrowsecurity');
    expect(scoped('T2').sql).toContain('relforcerowsecurity');
    expect(scoped('T3').sql).toContain('pg_policy');
    expect(scoped('T4').sql).toContain('pg_get_expr(p.polqual');
  });

  it('never ask about the metadata schema or the catalog', () => {
    for (const c of scopedChecks.filter((x) => x.id.startsWith('T') && x.id !== 'T4')) {
      expect(c.sql).toContain("n.nspname <> 'insightkit'");
      expect(c.sql).toContain("n.nspname NOT LIKE 'pg\\_%'");
    }
  });
});

describe('proveIsolation', () => {
  const clean = {
    rls_enabled: [
      ['public', 'users', true],
      ['public', 'orders', true],
    ],
    table_owner: [],
    policy_missing: [],
    policy_unconditional: [],
    current_user: [['postgres']],
    table_privileges: [],
    pg_auth_members: [],
    rolsuper: [
      ['ik_reader', false, false, false, false, false],
      ['ik_sdk', false, false, false, false, false],
    ],
    has_schema_privilege: [[false]],
    prosecdef: [],
    relkind: [],
    pg_extension: [],
  };

  it('proves isolation when every blocking check passes', async () => {
    const s = source(clean);
    const proof = await proveIsolation(s, checks);
    expect(proof.proven).toBe(true);
    expect(proof.blockers).toEqual([]);
  });

  it('runs its own reads inside a read-only transaction', async () => {
    const s = source(clean);
    await proveIsolation(s, checks);
    expect(s.log[0]).toBe('BEGIN READ ONLY');
    expect(s.log.at(-1)).toBe('ROLLBACK');
    expect(s.log.some((t) => /commit/i.test(t))).toBe(false);
  });

  it('does not treat a check it could not run as a pass', async () => {
    const s = source(clean, 'table_privileges');
    const proof = await proveIsolation(s, checks);
    expect(proof.proven).toBe(false);
    expect(proof.blockers.join(' ')).toContain('could not run');
  });

  it('fails the proof when the reader holds a write grant', async () => {
    const s = source({ ...clean, table_privileges: [['public', 'users', 'INSERT']] });
    const proof = await proveIsolation(s, checks);
    expect(proof.proven).toBe(false);
    expect(proof.blockers.join(' ')).toContain('A1');
  });

  it('reports review findings without failing the proof', async () => {
    const s = source({ ...clean, pg_extension: [['dblink']] });
    const proof = await proveIsolation(s, checks);
    expect(proof.proven).toBe(true);
    expect(proof.needsReview.join(' ')).toContain('B3');
  });

  it('releases the connection', async () => {
    const s = source(clean);
    await proveIsolation(s, checks);
    expect(s.released).toEqual([false]);
  });

  it('proves isolation with tenant scoping on when row security is enabled everywhere', async () => {
    const proof = await proveIsolation(source(clean), scopedChecks);
    expect(proof.proven).toBe(true);
    expect(proof.blockers).toEqual([]);
  });

  it('blocks with tenant scoping on when a readable table has row security off', async () => {
    const s = source({ ...clean, rls_enabled: [['public', 'users', false]] });
    const proof = await proveIsolation(s, scopedChecks);
    expect(proof.proven).toBe(false);
    expect(proof.blockers.join(' ')).toContain('T1');
  });

  it('does not block the same database when tenant scoping is off', async () => {
    const s = source({ ...clean, rls_enabled: [['public', 'users', false]] });
    const proof = await proveIsolation(s, checks);
    expect(proof.proven).toBe(true);
    expect(proof.needsReview.join(' ')).toContain('T1');
  });

  it('blocks when a readable table the reader owns does not force row security', async () => {
    const s = source({ ...clean, table_owner: [['public', 'users', 'ik_sdk']] });
    const proof = await proveIsolation(s, scopedChecks);
    expect(proof.proven).toBe(false);
    expect(proof.blockers.join(' ')).toContain('T2');
  });

  it('reports an unconditional policy for review without failing the proof', async () => {
    const s = source({ ...clean, policy_unconditional: [['public', 'users', 'everything']] });
    const proof = await proveIsolation(s, scopedChecks);
    expect(proof.proven).toBe(true);
    expect(proof.needsReview.join(' ')).toContain('T4');
  });

  it('does not treat an RLS check it could not run as a pass', async () => {
    const s = source(clean, 'rls_enabled');
    const proof = await proveIsolation(s, scopedChecks);
    expect(proof.proven).toBe(false);
    expect(proof.blockers.join(' ')).toContain('could not run');
  });
});
