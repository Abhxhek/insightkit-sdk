import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { runInit } from '../src/commands/init.js';
import { EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { bufferedOutput } from '../src/output.js';
import { cliDeps, FIXED_NOW, refuseToOpen, URL_WITH_SECRET } from './fake.js';

function init(argv: readonly string[] = []) {
  const out = bufferedOutput();
  const code = runInit(argv, { out, now: FIXED_NOW });
  return { out, code, sql: out.stdout.join('\n') };
}

const statementsOf = (lines: readonly string[]): readonly string[] =>
  lines.filter((line) => !line.startsWith('--') && line.trim() !== '');

describe('ik init', () => {
  it('prints the provisioning statements core produces, terminated', () => {
    const { code, out, sql } = init();
    expect(code).toBe(EXIT_OK);
    expect(sql).toContain('CREATE ROLE "ik_reader" NOLOGIN;');
    expect(sql).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "ik_reader";');
    expect(sql).toContain('ALTER ROLE "ik_sdk" SET default_transaction_read_only = on;');
    expect(statementsOf(out.stdout).every((s) => s.endsWith(';'))).toBe(true);
  });

  it('separates scoped from cluster-wide and says why the second group is different', () => {
    const { out, sql } = init();
    const scoped = out.stdout.findIndex((l) => l.startsWith('CREATE ROLE "ik_reader"'));
    const banner = out.stdout.findIndex((l) => l.includes('2. CLUSTER-WIDE'));
    const cluster = out.stdout.findIndex((l) => l.startsWith('REVOKE TEMPORARY ON DATABASE'));

    expect(out.stdout.some((l) => l.includes('1. SCOPED'))).toBe(true);
    expect(scoped).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(scoped);
    expect(cluster).toBeGreaterThan(banner);

    expect(sql).toContain('PUBLIC is every role in this cluster');
    expect(sql).toContain('none of it is covered by ik doctor');
  });

  it('puts no password, and nothing password-shaped, in any statement', () => {
    const { out, sql } = init();
    expect(statementsOf(out.stdout).some((s) => /password/i.test(s))).toBe(false);
    expect(sql).not.toMatch(/PASSWORD\s+'/i);
    expect(sql).toContain('\\password ik_sdk');
    expect(sql).toContain('There is no password in this script');
  });

  it('carries every flag into the script', () => {
    const { sql } = init([
      '--database',
      'shop',
      '--schema',
      'analytics',
      '--owner',
      'app',
      '--reader',
      'r_read',
      '--login',
      'r_login',
      '--meta-role',
      'r_meta',
      '--meta-schema',
      'ik_meta_data',
      '--connection-limit',
      '9',
      '--valid-until',
      '2030-01-31',
    ]);
    expect(sql).toContain('CREATE ROLE "r_read" NOLOGIN;');
    expect(sql).toContain('GRANT CONNECT ON DATABASE "shop" TO "r_read";');
    expect(sql).toContain('GRANT USAGE ON SCHEMA "analytics" TO "r_read";');
    expect(sql).toContain('CONNECTION LIMIT 9');
    expect(sql).toContain("VALID UNTIL '2030-01-31'");
    expect(sql).toContain('CREATE SCHEMA "ik_meta_data" AUTHORIZATION "r_meta";');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "app"');
  });

  it('defaults the expiry a year past the injected clock and says it is a hard stop', () => {
    const { sql } = init();
    expect(sql).toContain("VALID UNTIL '2027-09-27'");
    expect(sql).toContain('stops connecting on 2027-09-27');
  });

  it('drops the cluster-wide group on --scoped-only and warns that doctor will not catch it', () => {
    const { out, sql } = init(['--scoped-only']);
    expect(sql).toContain('CREATE ROLE "ik_reader" NOLOGIN;');
    expect(sql).not.toContain('REVOKE TEMPORARY ON DATABASE');
    expect(out.stderr.join('\n')).toContain('ik doctor does not check it');
  });

  it('warns on stderr, not stdout, when it had to guess the database and the owner', () => {
    const guessed = init();
    expect(guessed.out.stderr.join('\n')).toContain('--database');
    expect(guessed.out.stderr.join('\n')).toContain('--owner');

    const told = init(['--database', 'shop', '--owner', 'app']);
    expect(told.out.stderr.join('\n')).not.toContain('assumed');
  });

  it('turns a value core refuses into a usage error rather than a crash', async () => {
    const out = bufferedOutput();
    const code = await runCli(['init', '--reader', 'x"; DROP TABLE users --'], cliDeps(out, refuseToOpen));
    expect(code).toBe(EXIT_USAGE);
    expect(out.stderr.join('\n')).toContain('plain SQL identifier');
    expect(out.stderr.join('\n')).toContain("Run 'ik init --help'");
  });

  it('rejects a bad date and a bad connection limit', async () => {
    for (const argv of [
      ['init', '--valid-until', 'next tuesday'],
      ['init', '--connection-limit', '0'],
      ['init', '--connection-limit', 'lots'],
    ]) {
      const out = bufferedOutput();
      expect(await runCli(argv, cliDeps(out, refuseToOpen))).toBe(EXIT_USAGE);
    }
  });

  it('never opens a connection, even with a URL sitting in the environment', async () => {
    const out = bufferedOutput();
    const code = await runCli(['init'], cliDeps(out, refuseToOpen, { DATABASE_URL: URL_WITH_SECRET }));
    expect(code).toBe(EXIT_OK);
    expect(out.all()).not.toContain(URL_WITH_SECRET);
    expect(out.all()).not.toContain('hunter2');
  });
});
