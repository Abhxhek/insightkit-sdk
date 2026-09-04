import type { Guard, Policy } from '@insightkit/sql-guard';
import type { Approval, GuardedQuery } from './types.js';
import { GUARDED_BRAND } from './types.js';

export function approve(guard: Guard, sql: string, policy?: Policy): Approval {
  const verdict = policy === undefined ? guard(sql) : guard(sql, policy);
  if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail };

  const query = { sql: verdict.sql, tables: verdict.tables, rowLimit: verdict.rowLimit };
  Object.defineProperty(query, GUARDED_BRAND, { value: true, enumerable: false });
  return { ok: true, query: query as unknown as GuardedQuery };
}

export const isGuardedQuery = (value: unknown): value is GuardedQuery =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<symbol, unknown>)[GUARDED_BRAND] === true &&
  typeof (value as { sql?: unknown }).sql === 'string';
