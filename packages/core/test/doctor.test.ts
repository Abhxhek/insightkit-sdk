import { describe, expect, it } from 'vitest';
import { isolationChecks } from '../src/doctor/checks.js';
import { proveIsolation } from '../src/doctor/run.js';
import type { Check, QueryOutcome, SqlClient } from '../src/types.js';

const ROLES = { reader: 'ik_reader', login: 'ik_sdk', metadataSchema: 'insightkit' };
const checks = isolationChecks(ROLES);
const byId = (id: string): Check => {
  const c = checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check ${id}`);
  return c;
};

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

  it('refuses to build checks around a role name that is not an identifier', () => {
    expect(() => isolationChecks({ ...ROLES, login: "x'; DROP TABLE users --" })).toThrow(
      /plain SQL identifier/,
    );
    expect(() => isolationChecks({ ...ROLES, metadataSchema: 'a b' })).toThrow(/plain SQL identifier/);
  });
});

describe('proveIsolation', () => {
  const clean = {
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
});
