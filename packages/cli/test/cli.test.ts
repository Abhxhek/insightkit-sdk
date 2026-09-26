import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { openDatabase } from '../src/connect.js';
import { EXIT_CANNOT_RUN, EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { bufferedOutput } from '../src/output.js';
import { redact, redactorFor } from '../src/redact.js';
import { version } from '../src/version.js';
import { cliDeps, fakeDatabase, PASSWORD, refuseToOpen, URL_WITH_SECRET } from './fake.js';

const run = async (argv: readonly string[], env: Readonly<Record<string, string>> = {}) => {
  const out = bufferedOutput();
  const code = await runCli(argv, cliDeps(out, refuseToOpen, env));
  return { out, code };
};

describe('dispatch', () => {
  it('prints help to stdout for --help and exits zero', async () => {
    for (const argv of [['--help'], ['-h'], ['help']]) {
      const { out, code } = await run(argv);
      expect(code).toBe(EXIT_OK);
      expect(out.stdout.join('\n')).toContain('ik - InsightKit');
      expect(out.stderr).toEqual([]);
    }
  });

  it('documents every exit code in the tool help', async () => {
    const { out } = await run(['--help']);
    const help = out.stdout.join('\n');
    for (const line of ['  0  ', '  1  ', '  2  ', '  3  ']) expect(help).toContain(line);
  });

  it('prints help to stderr and exits non-zero when asked to do nothing', async () => {
    const { out, code } = await run([]);
    expect(code).toBe(EXIT_USAGE);
    expect(out.stdout).toEqual([]);
    expect(out.stderr.join('\n')).toContain('Usage');
  });

  it('prints the package version', async () => {
    const { out, code } = await run(['--version']);
    expect(code).toBe(EXIT_OK);
    expect(out.stdout).toEqual([version()]);
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects a command it does not have', async () => {
    const { out, code } = await run(['migrate']);
    expect(code).toBe(EXIT_USAGE);
    expect(out.stderr.join('\n')).toContain('no command called "migrate"');
    expect(out.stderr.join('\n')).toContain('init, doctor, introspect');
  });

  it('gives every command its own --help', async () => {
    for (const command of ['init', 'doctor', 'introspect']) {
      const { out, code } = await run([command, '--help']);
      expect(code).toBe(EXIT_OK);
      expect(out.stdout.join('\n')).toContain(`ik ${command} -`);
    }
  });
});

describe('argument parsing', () => {
  it('rejects an unknown flag rather than ignoring it', async () => {
    for (const command of ['init', 'doctor', 'introspect']) {
      const { out, code } = await run([command, '--recursive']);
      expect(code).toBe(EXIT_USAGE);
      expect(out.stderr.join('\n')).toContain('--recursive');
      expect(out.stdout).toEqual([]);
    }
  });

  it('rejects a stray positional rather than ignoring it', async () => {
    const { out, code } = await run(['init', 'production']);
    expect(code).toBe(EXIT_USAGE);
    expect(out.stderr.join('\n')).toMatch(/production/);
  });

  it('rejects a flag whose value is missing', async () => {
    const { code } = await run(['init', '--database']);
    expect(code).toBe(EXIT_USAGE);
  });

  it('points at the command help, not the tool help, when a flag is wrong', async () => {
    const { out } = await run(['doctor', '--nope']);
    expect(out.stderr.join('\n')).toContain("Run 'ik doctor --help'");
  });
});

describe('the connection URL never reaches the output', () => {
  const env = { DATABASE_URL: URL_WITH_SECRET };

  it('holds for every command, whatever the outcome', async () => {
    const db = fakeDatabase({ current_user: [['postgres']] });
    const cases: readonly (readonly string[])[] = [
      ['init'],
      ['init', '--help'],
      ['doctor'],
      ['doctor', '--nope'],
      ['introspect'],
      ['--help'],
      [],
    ];
    for (const argv of cases) {
      const out = bufferedOutput();
      await runCli(argv, cliDeps(out, db.open, env));
      expect(out.all()).not.toContain(URL_WITH_SECRET);
      expect(out.all()).not.toContain(PASSWORD);
    }
  });

  it('says which variable is missing without inventing a value for it', async () => {
    const out = bufferedOutput();
    const code = await runCli(['doctor', '--url-env', 'PG_URL'], cliDeps(out, openDatabase, env));
    expect(code).toBe(EXIT_CANNOT_RUN);
    expect(out.stderr.join('\n')).toContain('PG_URL is not set');
    expect(out.all()).not.toContain(PASSWORD);
  });

  it('refuses a URL it cannot use without quoting it back', async () => {
    // "host:port/db" is a URL whose scheme is the hostname, so a scheme check is what
    // catches the common paste, not a try/catch around new URL().
    for (const url of ['db.internal:6432/shop?password=hunter2', 'mysql://u:hunter2@db/shop', 'nonsense']) {
      const out = bufferedOutput();
      const code = await runCli(['doctor'], cliDeps(out, openDatabase, { DATABASE_URL: url }));
      expect(code).toBe(EXIT_CANNOT_RUN);
      expect(out.stderr.join('\n')).toContain('is not a Postgres connection URL');
      expect(out.all()).not.toContain('hunter2');
    }
  });

  it('rejects an empty variable instead of treating it as absent data', async () => {
    const out = bufferedOutput();
    const code = await runCli(['introspect'], cliDeps(out, openDatabase, { DATABASE_URL: '   ' }));
    expect(code).toBe(EXIT_CANNOT_RUN);
    expect(out.stderr.join('\n')).toContain('DATABASE_URL is not set');
  });

  it('leaves the example URL in its own guidance readable', async () => {
    const out = bufferedOutput();
    await runCli(['doctor'], cliDeps(out, openDatabase, {}));
    expect(out.stderr.join('\n')).toContain('postgres://user:password@host:5432/database');
    expect(out.stderr.join('\n')).not.toContain('[redacted]');
  });
});

describe('redact', () => {
  it('strips credentials from a URL but keeps the host, which is not a secret', () => {
    expect(redact(`connect failed: ${URL_WITH_SECRET}`)).toBe(
      'connect failed: postgres://[redacted]@db.internal:6432/shop',
    );
  });

  it('strips a password carried as a query parameter', () => {
    expect(redact('postgres://db/app?sslmode=require&password=hunter2')).toContain('password=[redacted]');
    expect(redact('postgres://db/app?password=hunter2')).not.toContain('hunter2');
  });

  it('strips a key-shaped token wherever it appears', () => {
    expect(redact('Authorization: bearer_abcdefghijklmnop')).toBe('Authorization: [redacted]');
    expect(redact('sk-ant-api03-aaaaaaaaaaaaaaaa')).toBe('[redacted]');
  });

  it('replaces a known secret literally, and leaves short strings alone', () => {
    const scrub = redactorFor([PASSWORD, 'ab']);
    expect(scrub(`the password is ${PASSWORD}`)).toBe('the password is [redacted]');
    expect(scrub('ab cd')).toBe('ab cd');
  });

  it('leaves a role name alone, because every check detail names one', () => {
    expect(redact('running as postgres')).toBe('running as postgres');
    expect(redactorFor([URL_WITH_SECRET])('running as ik_admin')).toBe('running as ik_admin');
  });
});
