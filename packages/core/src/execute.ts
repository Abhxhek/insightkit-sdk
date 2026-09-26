import { isGuardedQuery } from './approve.js';
import { isReaderSource } from './source.js';
import { assertIdent, quoteLiteral } from './sql.js';
import type {
  GuardedQuery,
  QueryOutcome,
  ReaderSource,
  ReadOptions,
  ReadResult,
  ResultSet,
} from './types.js';

export const BEGIN_READ_ONLY = 'BEGIN READ ONLY';
export const ROLLBACK = 'ROLLBACK';
export const ASSERT_READ_ONLY = 'SHOW transaction_read_only';

const MAX_TIMEOUT_MS = 600_000;
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_SETTING_VALUE = 256;

const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
// pg_temp is excluded on purpose: a writable temp schema on the search path is the
// CVE-2018-1058 function-shadowing vector.
const DEFAULT_SEARCH_PATH: readonly string[] = ['pg_catalog', 'public'];

const timeout = (name: string, value: number): string => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must be an integer between 1 and ${MAX_TIMEOUT_MS} ms, got ${value}`);
  }
  return `${value}ms`;
};

const ident = (name: string): string => {
  if (!SAFE_IDENT.test(name)) {
    throw new RangeError(`unsafe identifier in search path: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
};

export interface SessionSetting {
  readonly name: string;
  readonly value: string;
}

export interface ScopedReadOptions extends ReadOptions {
  readonly scope?: readonly SessionSetting[];
}

// A prefix is required because an unprefixed name is a built-in GUC: without the dot a
// caller could aim a scope setting at row_security or search_path.
export function assertSettingName(name: string): string {
  const parts = name.split('.');
  if (parts.length !== 2) {
    throw new RangeError(`session setting must be prefix.name, got ${JSON.stringify(name)}`);
  }
  for (const part of parts) assertIdent(part, 'session setting name');
  if (name !== name.toLowerCase()) {
    throw new RangeError(`session setting must be lower case, got ${JSON.stringify(name)}`);
  }
  return name;
}

const hasUnsafeChar = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
};

// Backslashes are refused rather than escaped: doubling the quote is only sufficient while
// standard_conforming_strings is on, and that is the host's setting, not ours.
export function assertSettingValue(value: string, what: string): string {
  if (value.length === 0) throw new RangeError(`${what} must not be empty`);
  if (value.length > MAX_SETTING_VALUE) {
    throw new RangeError(`${what} must be at most ${MAX_SETTING_VALUE} characters, got ${value.length}`);
  }
  if (value !== value.trim()) {
    throw new RangeError(`${what} must not have leading or trailing whitespace`);
  }
  if (hasUnsafeChar(value)) {
    throw new RangeError(`${what} contains a control character or a backslash`);
  }
  return value;
}

export function setLocal(setting: SessionSetting): string {
  const name = assertSettingName(setting.name);
  const value = assertSettingValue(setting.value, `value of ${name}`);
  return `SET LOCAL ${name} = ${quoteLiteral(value, `value of ${name}`)}`;
}

const scopeStatements = (scope: readonly SessionSetting[]): readonly string[] => {
  const seen = new Set<string>();
  return scope.map((setting) => {
    const statement = setLocal(setting);
    if (seen.has(setting.name)) {
      throw new RangeError(`session setting ${setting.name} is set more than once`);
    }
    seen.add(setting.name);
    return statement;
  });
};

export function sessionPreamble(options: ScopedReadOptions = {}): readonly string[] {
  const statement = timeout('statementTimeoutMs', options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS);
  const lock = timeout('lockTimeoutMs', options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const idle = timeout(
    'idleInTransactionTimeoutMs',
    options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
  );
  const path = (options.searchPath ?? DEFAULT_SEARCH_PATH).map(ident);
  if (path.length === 0) throw new RangeError('searchPath must name at least one schema');

  return [
    `SET LOCAL statement_timeout = '${statement}'`,
    `SET LOCAL lock_timeout = '${lock}'`,
    `SET LOCAL idle_in_transaction_session_timeout = '${idle}'`,
    'SET LOCAL row_security = on',
    `SET LOCAL search_path = ${path.join(', ')}`,
    ...scopeStatements(options.scope ?? []),
  ];
}

const toResultSet = (outcome: QueryOutcome): ResultSet => ({
  columns: outcome.fields.map((f) => f.name),
  rows: outcome.rows,
});

const firstCell = (outcome: QueryOutcome): unknown => outcome.rows[0]?.[0];

export async function runGuardedRead(
  source: ReaderSource,
  query: GuardedQuery,
  options: ScopedReadOptions = {},
): Promise<ReadResult> {
  if (!isReaderSource(source)) {
    throw new TypeError('runGuardedRead requires a source produced by asReaderSource');
  }
  if (!isGuardedQuery(query)) {
    throw new TypeError('runGuardedRead requires a query produced by approve; it was handed a plain object');
  }

  const preamble = sessionPreamble(options);
  const client = await source.connect();
  const statements: string[] = [];
  let rolledBack = false;

  const run = async (text: string): Promise<QueryOutcome> => {
    statements.push(text);
    return client.query(text);
  };

  try {
    await run(BEGIN_READ_ONLY);
    for (const statement of preamble) await run(statement);

    const proof = await run(ASSERT_READ_ONLY);
    if (firstCell(proof) !== 'on') {
      throw new Error(
        `the server does not report this transaction as read only: ${String(firstCell(proof))}`,
      );
    }

    const outcome = await run(query.sql);
    return {
      rows: toResultSet(outcome),
      rowLimit: query.rowLimit,
      reachedLimit: query.rowLimit !== null && outcome.rows.length >= query.rowLimit,
      statements,
    };
  } finally {
    try {
      await run(ROLLBACK);
      rolledBack = true;
    } catch {
      rolledBack = false;
    }
    client.release(!rolledBack);
  }
}
