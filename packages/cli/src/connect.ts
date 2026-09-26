import type { ConnectionSource } from '@insightkit/core';
import type { PgPool } from '@insightkit/core/pg';
import { fromPgPool } from '@insightkit/core/pg';
import { CannotRunError, messageOf } from './errors.js';
import type { Output } from './output.js';
import type { Redactor } from './redact.js';
import { redactorFor, secretRedactorFor } from './redact.js';

export type Env = Readonly<Record<string, string | undefined>>;

export interface OpenOptions {
  readonly urlEnv: string;
  readonly timeoutMs: number;
  readonly env: Env;
}

export interface Connection {
  readonly source: ConnectionSource;
  /** host:port/database, and nothing else. Never the user, the password or the URL. */
  readonly label: string;
  /** For error text: also strips anything key-shaped. */
  readonly scrub: Redactor;
  /**
   * For anything read back from the database. Only the exact URL and password, because
   * a check detail can carry a driver error but a table named token_expires_audit is
   * not a secret and must survive intact.
   */
  readonly scrubSecrets: Redactor;
  close(): Promise<void>;
}

export type Opener = (options: OpenOptions) => Promise<Connection>;

interface ClosablePool extends PgPool {
  end(): Promise<void>;
}

interface PoolModule {
  readonly Pool: new (config: Readonly<Record<string, unknown>>) => ClosablePool;
}

// Not a literal: @types/pg is not a dependency of this package, and pg is an optional
// peer, so the driver is resolved when a command needs it rather than at load time.
const DRIVER = 'pg';

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const SCHEMES: ReadonlySet<string> = new Set(['postgres:', 'postgresql:']);

function parseUrl(raw: string, urlEnv: string): URL {
  // Never quote the value back: the parse error would carry the credentials, and
  // "host:5432/db" parses as a URL whose scheme is the hostname.
  const bad = new CannotRunError(
    `${urlEnv} is not a Postgres connection URL. Expected postgres://user:password@host:5432/database`,
  );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad;
  }
  if (!SCHEMES.has(url.protocol)) throw bad;
  return url;
}

export const openDatabase: Opener = async ({ urlEnv, timeoutMs, env }) => {
  const raw = env[urlEnv];
  if (raw === undefined || raw.trim() === '') {
    throw new CannotRunError(
      `${urlEnv} is not set. Point it at an administrative connection, for example ` +
        `${urlEnv}=postgres://user:password@host:5432/database`,
    );
  }

  const url = parseUrl(raw, urlEnv);
  const secrets = [raw, url.password, decode(url.password)];
  const scrub = redactorFor(secrets);
  const scrubSecrets = secretRedactorFor(secrets);
  const database = decode(url.pathname.replace(/^\//, ''));
  const label = `${url.hostname === '' ? 'localhost' : url.hostname}:${url.port === '' ? '5432' : url.port}/${database === '' ? '(default)' : database}`;

  let driver: PoolModule;
  try {
    driver = (await import(DRIVER)) as PoolModule;
  } catch {
    throw new CannotRunError(
      'this command needs node-postgres, which is an optional peer dependency. Install pg alongside @insightkit/cli',
    );
  }

  // max 1: doctor and introspect each hold one connection at a time, and this runs
  // against somebody's production cluster.
  const pool = new driver.Pool({
    connectionString: raw,
    connectionTimeoutMillis: timeoutMs,
    max: 1,
    application_name: 'insightkit-cli',
  });

  return {
    source: fromPgPool(pool),
    label,
    scrub,
    scrubSecrets,
    close: () => pool.end(),
  };
};

/** A pool that will not close is worth a line, never worth losing the result over. */
export async function closeQuietly(connection: Connection, out: Output): Promise<void> {
  try {
    await connection.close();
  } catch (err) {
    out.err(`ik: the connection did not close cleanly: ${connection.scrub(messageOf(err))}`);
  }
}
