import { loadModule } from 'pgsql-parser';
import { guardWith } from './guard.js';
import type { Guard, Policy } from './types.js';

export { ALLOWED_FIELDS, ALLOWED_TAGS } from './allowlist.js';
export { ALLOWED_FUNCTIONS } from './functions.js';
export type { DenyCode, Guard, Policy, TableRef, Verdict } from './types.js';

export async function createGuard(defaults: Policy = {}): Promise<Guard> {
  await loadModule();
  return (sql: string, policy?: Policy) => guardWith(sql, { ...defaults, ...policy });
}
