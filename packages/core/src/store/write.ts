import { isAdminSource } from '../source.js';
import type { AdminSource, QueryOutcome } from '../types.js';
import { quoteSchema } from './names.js';

export const BEGIN_WRITE = 'BEGIN';
export const COMMIT = 'COMMIT';
export const ROLLBACK = 'ROLLBACK';

const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

declare const STATEMENT: unique symbol;

export const STATEMENT_BRAND = Symbol.for('insightkit.store.statement');

export interface Statement {
  readonly text: string;
  readonly [STATEMENT]: true;
}

export type RunStatement = (statement: Statement) => Promise<QueryOutcome>;

export interface WriteOptions {
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
}

const LEADING: readonly string[] = [
  'SET LOCAL ',
  'SELECT ',
  'INSERT INTO ',
  'UPDATE ',
  'DELETE FROM ',
  'CREATE SCHEMA ',
  'CREATE TABLE ',
  'CREATE INDEX ',
];

const TOUCHES_DATA: ReadonlySet<string> = new Set([
  'SELECT ',
  'INSERT INTO ',
  'UPDATE ',
  'DELETE FROM ',
  'CREATE SCHEMA ',
  'CREATE TABLE ',
  'CREATE INDEX ',
]);

/**
 * The only producer of a Statement, and not part of the surface a host wires. Every
 * verb is on an allowlist and anything reaching a relation must name the metadata schema,
 * so a composition bug that aimed at a customer's table fails here rather than at the
 * server. It is not a sanitiser: the caller never supplies SQL in the first place.
 */
export function composeStatement(text: string, schema: string): Statement {
  if (text.includes('\u0000')) throw new RangeError('statement contains a NUL byte');
  const verb = LEADING.find((v) => text.startsWith(v));
  if (verb === undefined) {
    throw new RangeError(
      `statement does not begin with an allowed verb: ${JSON.stringify(text.slice(0, 40))}`,
    );
  }
  if (TOUCHES_DATA.has(verb) && !text.includes(quoteSchema(schema))) {
    throw new RangeError(
      `statement reaches a relation outside ${schema}: ${JSON.stringify(text.slice(0, 80))}`,
    );
  }
  const statement = { text };
  Object.defineProperty(statement, STATEMENT_BRAND, { value: true, enumerable: false });
  return statement as unknown as Statement;
}

export const isStatement = (value: unknown): value is Statement =>
  typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[STATEMENT_BRAND] === true;

const timeout = (name: string, value: number): string => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must be an integer between 1 and ${MAX_TIMEOUT_MS} ms, got ${value}`);
  }
  return `${value}ms`;
};

/**
 * pg_temp is absent for the same reason it is absent from the reader path, and
 * standard_conforming_strings is pinned on because every payload here is an escaped
 * literal and doubling the quote is only sufficient while it is.
 */
export function writePreamble(schema: string, options: WriteOptions = {}): readonly string[] {
  const statement = timeout('statementTimeoutMs', options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS);
  const lock = timeout('lockTimeoutMs', options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const idle = timeout(
    'idleInTransactionTimeoutMs',
    options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
  );
  return [
    `SET LOCAL statement_timeout = '${statement}'`,
    `SET LOCAL lock_timeout = '${lock}'`,
    `SET LOCAL idle_in_transaction_session_timeout = '${idle}'`,
    'SET LOCAL row_security = on',
    'SET LOCAL standard_conforming_strings = on',
    `SET LOCAL search_path = pg_catalog, ${quoteSchema(schema)}`,
  ];
}

export async function inWriteTransaction<T>(
  source: AdminSource,
  schema: string,
  body: (run: RunStatement) => Promise<T>,
  options: WriteOptions = {},
): Promise<T> {
  if (!isAdminSource(source)) {
    throw new TypeError('the metadata store requires a source produced by asAdminSource');
  }
  const preamble = writePreamble(schema, options).map((text) => composeStatement(text, schema));
  const client = await source.connect();

  const run: RunStatement = (statement) => {
    if (!isStatement(statement)) {
      throw new TypeError('the metadata store only runs statements it composed itself');
    }
    return client.query(statement.text);
  };

  let settled = false;
  let broken = false;
  try {
    await client.query(BEGIN_WRITE);
    for (const statement of preamble) await run(statement);
    const value = await body(run);
    await client.query(COMMIT);
    settled = true;
    return value;
  } catch (err) {
    try {
      await client.query(ROLLBACK);
      settled = true;
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken || !settled);
  }
}
