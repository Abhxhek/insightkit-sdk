import type { DenyCode, TableRef } from '@insightkit/sql-guard';

export interface ResultSet {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

/**
 * Rows must arrive as arrays, not objects. `SELECT a.id, b.id` collapses to a
 * single key when a driver returns objects, silently losing a column.
 */
export interface QueryOutcome {
  readonly fields: readonly { readonly name: string }[];
  readonly rows: readonly (readonly unknown[])[];
}

export interface SqlClient {
  query(text: string): Promise<QueryOutcome>;
  release(destroy?: boolean): void;
}

export interface ConnectionSource {
  connect(): Promise<SqlClient>;
}

declare const READER: unique symbol;
declare const ADMIN: unique symbol;
declare const GUARDED: unique symbol;

export const READER_BRAND = Symbol.for('insightkit.source.reader');
export const ADMIN_BRAND = Symbol.for('insightkit.source.admin');
export const GUARDED_BRAND = Symbol.for('insightkit.query.guarded');

export interface ReaderSource extends ConnectionSource {
  readonly [READER]: true;
}

export interface AdminSource extends ConnectionSource {
  readonly [ADMIN]: true;
}

export interface GuardedQuery {
  readonly sql: string;
  readonly tables: readonly TableRef[];
  readonly rowLimit: number | null;
  readonly [GUARDED]: true;
}

export type Approval =
  | { readonly ok: true; readonly query: GuardedQuery }
  | { readonly ok: false; readonly code: DenyCode; readonly detail: string };

export interface ReadOptions {
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  readonly searchPath?: readonly string[];
}

export interface ReadResult {
  readonly rows: ResultSet;
  readonly rowLimit: number | null;
  readonly reachedLimit: boolean;
  readonly statements: readonly string[];
}

export type CheckStatus = 'pass' | 'fail' | 'review';

export interface CheckOutcome {
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly blocking: boolean;
  readonly sql: string;
  readonly evaluate: (rows: readonly (readonly unknown[])[]) => CheckOutcome;
}

export interface CheckReport {
  readonly id: string;
  readonly title: string;
  readonly blocking: boolean;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface IsolationProof {
  readonly proven: boolean;
  readonly checks: readonly CheckReport[];
  readonly blockers: readonly string[];
  readonly needsReview: readonly string[];
}
