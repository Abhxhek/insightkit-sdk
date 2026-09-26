import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_CANNOT_RUN, EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { bufferedOutput } from '../src/output.js';
import type { Answers, FakeOptions } from './fake.js';
import { cliDeps, fakeDatabase, LABEL, PASSWORD, URL_WITH_SECRET } from './fake.js';

const CATALOG: Answers = {
  current_user: [['ik_sdk']],
  'c.relkind::text': [
    ['public', 'users', 'r', '1200', 'people who signed up'],
    ['public', 'orders', 'r', '48000', null],
  ],
  format_type: [
    ['public', 'users', 'id', 'bigint', 20, true, null],
    ['public', 'users', 'email', 'text', 25, false, 'login address'],
    ['public', 'orders', 'id', 'bigint', 20, true, null],
    ['public', 'orders', 'user_id', 'bigint', 20, true, null],
    ['public', 'orders', 'total_cents', 'integer', 23, false, null],
  ],
  "contype = 'p'": [
    ['public', 'users', 'id'],
    ['public', 'orders', 'id'],
  ],
  "contype = 'f'": [['orders_user_id_fkey', 'public', 'orders', 'user_id', 'public', 'users', 'id']],
};

const EMPTY: Answers = { current_user: [['ik_sdk']] };

function introspect(argv: readonly string[] = [], answers: Answers = CATALOG, options: FakeOptions = {}) {
  const db = fakeDatabase(answers, options);
  const out = bufferedOutput();
  const env = { DATABASE_URL: URL_WITH_SECRET };
  return { db, out, run: () => runCli(['introspect', ...argv], cliDeps(out, db.open, env)) };
}

describe('ik introspect', () => {
  it('prints DDL for the tables the catalog reports', async () => {
    const { run, out } = introspect();
    expect(await run()).toBe(EXIT_OK);
    const ddl = out.stdout.join('\n');
    expect(ddl).toContain('CREATE TABLE public.users (');
    expect(ddl).toContain('id bigint NOT NULL');
    expect(ddl).toContain('email text, -- login address');
    expect(ddl).toContain('PRIMARY KEY (id)');
    expect(ddl).toContain('CREATE TABLE public.orders (');
    expect(ddl).toContain('FOREIGN KEY (user_id) REFERENCES public.users (id)');
    expect(ddl).toContain('-- people who signed up');
    expect(ddl).toContain('-- approximately 1,200 rows');
  });

  it('heads the output with whose visibility it describes and where', async () => {
    const { run, out } = introspect();
    await run();
    expect(out.stdout[0]).toBe(`-- schema visible to ik_sdk on ${LABEL}`);
    expect(out.stdout[1]).toBe('-- 2 tables, 1 foreign key');
  });

  it('drops comments and row counts on request', async () => {
    const { run, out } = introspect(['--no-comments', '--no-row-counts']);
    await run();
    const ddl = out.stdout.join('\n');
    expect(ddl).toContain('CREATE TABLE public.users (');
    expect(ddl).not.toContain('people who signed up');
    expect(ddl).not.toContain('login address');
    expect(ddl).not.toContain('approximately');
  });

  it('always excludes the metadata schema and honours --schema and --exclude-schema', async () => {
    const { run, db } = introspect([
      '--schema',
      'analytics',
      '--schema',
      'billing',
      '--exclude-schema',
      'staging',
      '--meta-schema',
      'ik_meta_data',
    ]);
    await run();
    const sent = db.log.join('\n');
    expect(sent).toContain("IN ('analytics', 'billing')");
    expect(sent).toContain("nspname <> 'ik_meta_data'");
    expect(sent).toContain("nspname <> 'staging'");
  });

  it('excludes insightkit by default', async () => {
    const { run, db } = introspect();
    await run();
    expect(db.log.join('\n')).toContain("nspname <> 'insightkit'");
  });

  it('says so when a cap truncated the answer, in the output itself', async () => {
    const { run, out } = introspect(['--max-tables', '1']);
    expect(await run()).toBe(EXIT_OK);
    const ddl = out.stdout.join('\n');
    expect(ddl).toContain('-- TRUNCATED at --max-tables 1');
    expect(ddl).toContain('CREATE TABLE public.users (');
    expect(ddl).not.toContain('CREATE TABLE public.orders (');
    // The foreign key points at a table that was cut, so it is not rendered.
    expect(ddl).not.toContain('FOREIGN KEY');
  });

  it('explains an empty answer rather than printing nothing', async () => {
    const { run, out } = introspect([], EMPTY);
    expect(await run()).toBe(EXIT_OK);
    expect(out.stdout.join('\n')).toContain('-- 0 tables, 0 foreign keys');
    expect(out.stdout.join('\n')).toContain('Nothing is visible to ik_sdk here');
  });

  it('reads inside a read-only transaction that is rolled back, and writes nothing', async () => {
    const { run, db } = introspect();
    await run();
    expect(db.log[0]).toBe('BEGIN READ ONLY');
    expect(db.log.at(-1)).toBe('ROLLBACK');
    expect(db.log.some((sql) => /\bcommit\b/i.test(sql))).toBe(false);
    expect(db.log.some((sql) => /^\s*(insert|update|delete|create|drop|alter|truncate)\b/i.test(sql))).toBe(
      false,
    );
  });

  it('applies the statement timeout it was given', async () => {
    const { run, db } = introspect(['--statement-timeout', '45000']);
    await run();
    expect(db.log).toContain("SET LOCAL statement_timeout = '45000ms'");
  });

  it('closes the connection on success and on failure', async () => {
    const good = introspect();
    await good.run();
    expect(good.db.closes).toEqual([true]);

    const bad = introspect([], CATALOG, { connectError: 'ECONNREFUSED' });
    expect(await bad.run()).toBe(EXIT_CANNOT_RUN);
    expect(bad.db.closes).toEqual([true]);
  });

  it('never prints the connection string, the user or the password', async () => {
    for (const options of [{}, { failOn: 'format_type' }, { connectError: URL_WITH_SECRET }]) {
      const { run, out } = introspect([], CATALOG, options);
      await run();
      expect(out.all()).not.toContain(URL_WITH_SECRET);
      expect(out.all()).not.toContain(PASSWORD);
      expect(out.all()).not.toContain('ik_admin:');
    }
  });

  it('rejects a cap outside the range core accepts, before it connects', async () => {
    const { run, db } = introspect(['--max-tables', '0']);
    expect(await run()).toBe(EXIT_USAGE);
    expect(db.opened).toEqual([]);
  });

  it('answers --help without connecting', async () => {
    const { run, out, db } = introspect(['--help']);
    expect(await run()).toBe(EXIT_OK);
    expect(out.stdout.join('\n')).toContain('ik introspect');
    expect(db.opened).toEqual([]);
  });
});
