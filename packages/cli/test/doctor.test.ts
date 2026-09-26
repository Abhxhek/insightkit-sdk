import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_CANNOT_RUN, EXIT_NOT_PROVEN, EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { bufferedOutput } from '../src/output.js';
import type { Answers, FakeOptions } from './fake.js';
import { cliDeps, fakeDatabase, LABEL, PASSWORD, URL_WITH_SECRET } from './fake.js';

const CLEAN: Answers = {
  // Ahead of `relkind`, which is the views check: the fake matches by substring and
  // the row-security queries name relkind too, so the specific needle has to win.
  relrowsecurity: [['public', 'orders', true]],
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

function doctor(argv: readonly string[] = [], answers: Answers = CLEAN, options: FakeOptions = {}) {
  const db = fakeDatabase(answers, options);
  const out = bufferedOutput();
  const env = { DATABASE_URL: URL_WITH_SECRET };
  return { db, out, run: () => runCli(['doctor', ...argv], cliDeps(out, db.open, env)) };
}

describe('ik doctor', () => {
  it('exits zero and reports every check when the proof holds', async () => {
    const { run, out } = doctor();
    expect(await run()).toBe(EXIT_OK);
    const report = out.stdout.join('\n');
    for (const id of ['A0', 'A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3']) expect(report).toContain(id);
    expect(report).toContain('PASS');
    expect(report).toContain('PROVEN - 5 blocking checks passed.');
    expect(report).not.toContain('NOT PROVEN');
  });

  it('exits non-zero when a blocking check fails, and names the blocker', async () => {
    const { run, out } = doctor([], { ...CLEAN, table_privileges: [['public', 'users', 'INSERT']] });
    expect(await run()).toBe(EXIT_NOT_PROVEN);
    const report = out.stdout.join('\n');
    expect(report).toContain('FAIL');
    expect(report).toContain('Blockers - the proof does not hold:');
    expect(report).toContain('A1:');
    expect(report).toContain('NOT PROVEN - 1 blocking check of 5 did not pass.');
  });

  it('explains A0 rather than just failing, because A0 is about how it was run', async () => {
    const { run, out } = doctor([], { ...CLEAN, current_user: [['ik_sdk']] });
    expect(await run()).toBe(EXIT_NOT_PROVEN);
    expect(out.stdout.join('\n')).toContain('under-report from inside');
    expect(out.stdout.join('\n')).toContain('administrative role');
  });

  it('separates "could not run" from "the proof failed"', async () => {
    const { run, out } = doctor([], CLEAN, { connectError: 'connect ECONNREFUSED 10.0.0.4:6432' });
    expect(await run()).toBe(EXIT_CANNOT_RUN);
    expect(EXIT_CANNOT_RUN).not.toBe(EXIT_NOT_PROVEN);
    expect(out.stderr.join('\n')).toContain('could not run the proof');
    expect(out.stdout).toEqual([]);
  });

  it('counts a check it could not run as a failed proof, not as a clean one', async () => {
    const { run, out } = doctor([], CLEAN, { failOn: 'table_privileges' });
    expect(await run()).toBe(EXIT_NOT_PROVEN);
    expect(out.stdout.join('\n')).toContain('could not run');
  });

  it('reports review findings without failing, unless --strict', async () => {
    const noisy: Answers = { ...CLEAN, pg_extension: [['dblink']] };

    const lenient = doctor([], noisy);
    expect(await lenient.run()).toBe(EXIT_OK);
    expect(lenient.out.stdout.join('\n')).toContain('REVIEW');
    expect(lenient.out.stdout.join('\n')).toContain('Needs review');
    // The count is derived, not hardcoded: pinning a number here couples a CLI test to
    // however many checks core happens to ship, which broke the moment doctor grew the
    // row-security checks. The property worth testing is that the tally matches.
    const text = lenient.out.stdout.join('\n');
    const reviewed = text.split('\n').filter((line) => line.includes('REVIEW')).length;
    expect(reviewed).toBeGreaterThan(0);
    expect(text).toMatch(new RegExp(`${reviewed} findings? needs? review\\.`));

    const strict = doctor(['--strict'], noisy);
    expect(await strict.run()).toBe(EXIT_NOT_PROVEN);
    expect(strict.out.stdout.join('\n')).toMatch(
      new RegExp(`--strict fails on ${reviewed} review findings?`),
    );
  });

  it('proves inside a read-only transaction that is rolled back, and writes nothing', async () => {
    const { run, db } = doctor();
    await run();
    expect(db.log[0]).toBe('BEGIN READ ONLY');
    expect(db.log.at(-1)).toBe('ROLLBACK');
    expect(db.log.some((sql) => /\bcommit\b/i.test(sql))).toBe(false);
    expect(db.log.some((sql) => /^\s*(insert|update|delete|create|drop|alter|truncate)\b/i.test(sql))).toBe(
      false,
    );
  });

  it('closes the connection whether the proof holds or the run falls over', async () => {
    const good = doctor();
    await good.run();
    expect(good.db.closes).toEqual([true]);

    const bad = doctor([], CLEAN, { connectError: 'ECONNREFUSED' });
    await bad.run();
    expect(bad.db.closes).toEqual([true]);
  });

  it('prints host and database but never the URL, the user or the password', async () => {
    const cases: [readonly string[], Answers, FakeOptions][] = [
      [[], CLEAN, {}],
      [[], { ...CLEAN, table_privileges: [['public', 'users', 'INSERT']] }, {}],
      [[], CLEAN, { failOn: 'table_privileges' }],
      [[], CLEAN, { connectError: `refused by ${URL_WITH_SECRET}` }],
    ];
    for (const [argv, answers, options] of cases) {
      const { run, out } = doctor(argv, answers, options);
      await run();
      expect(out.all()).toContain(LABEL);
      expect(out.all()).not.toContain(URL_WITH_SECRET);
      expect(out.all()).not.toContain(PASSWORD);
      expect(out.all()).not.toContain('ik_admin:');
    }
  });

  it('redacts a driver error that quotes the URL back', async () => {
    const { run, out } = doctor([], CLEAN, { connectError: `refused by ${URL_WITH_SECRET}` });
    expect(await run()).toBe(EXIT_CANNOT_RUN);
    expect(out.stderr.join('\n')).toContain('[redacted]');
  });

  it('redacts a driver error that core folded into a check detail', async () => {
    const { run, out } = doctor([], CLEAN, { failOn: 'table_privileges' });
    await run();
    const report = out.stdout.join('\n');
    expect(report).toContain('check could not run');
    expect(report).toContain('[redacted]');
    expect(report).not.toContain(PASSWORD);
    expect(report).not.toContain(URL_WITH_SECRET);
  });

  it('passes the roles and the timeout through instead of hard-coding them', async () => {
    const { run, db } = doctor([
      '--reader',
      'r_read',
      '--login',
      'r_login',
      '--meta-schema',
      'ik_meta_data',
      '--timeout',
      '2500',
      '--url-env',
      'PG_URL',
    ]);
    await run();
    expect(db.opened[0]?.urlEnv).toBe('PG_URL');
    expect(db.opened[0]?.timeoutMs).toBe(2500);
    const sent = db.log.join('\n');
    expect(sent).toContain("'r_read'");
    expect(sent).toContain("'r_login'");
    expect(sent).toContain("'ik_meta_data'");
  });

  it('refuses a role name that is not an identifier before it connects', async () => {
    const { run, out, db } = doctor(['--login', "x'; DROP TABLE users --"]);
    expect(await run()).toBe(EXIT_USAGE);
    expect(db.opened).toEqual([]);
    expect(out.stderr.join('\n')).toContain('plain SQL identifier');
  });

  it('rejects a timeout that is not a number, before it connects', async () => {
    const { run, db } = doctor(['--timeout', 'soon']);
    expect(await run()).toBe(EXIT_USAGE);
    expect(db.opened).toEqual([]);
  });

  it('answers --help without connecting', async () => {
    const { run, out, db } = doctor(['--help']);
    expect(await run()).toBe(EXIT_OK);
    expect(out.stdout.join('\n')).toContain('ik doctor');
    expect(db.opened).toEqual([]);
  });
});
