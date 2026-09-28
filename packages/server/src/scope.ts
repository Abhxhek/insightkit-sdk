import type {
  GuardedQuery,
  ReaderSource,
  ReadOptions,
  ReadResult,
  SessionSetting,
  TenantScope,
} from '@insightkit/core';
import { isIdentityError, runGuardedRead } from '@insightkit/core';
import type { TenancyConfig } from './types.js';
import { SINGLE_TENANT_ACKNOWLEDGEMENT } from './types.js';

declare const SCOPED: unique symbol;

export const SCOPE_BRAND = Symbol.for('insightkit.server.scope');

/**
 * The proof that a request became a tenant. Only the two producers below can mint one, and
 * `runScopedRead` is the only caller of `runGuardedRead` in this package, so a read with no
 * scope cannot happen without passing through the acknowledgement.
 */
export interface ReadScope {
  readonly settings: readonly SessionSetting[];
  /** Rate-limit bucket, and what a stream token is bound to. */
  readonly identity: string;
  /** True only for a host that declared single-tenant mode. Never inferred from an empty scope. */
  readonly unscoped: boolean;
  readonly [SCOPED]: true;
}

const mint = (settings: readonly SessionSetting[], identity: string, unscoped: boolean): ReadScope => {
  const scope = { settings, identity, unscoped };
  Object.defineProperty(scope, SCOPE_BRAND, { value: true, enumerable: false });
  return scope as unknown as ReadScope;
};

export function tenantReadScope(scope: TenantScope): ReadScope {
  if (scope.settings.length === 0) {
    throw new TypeError('a tenant scope produced no session settings; refusing to read unscoped');
  }
  return mint(scope.settings, scope.tenantId, false);
}

/**
 * The only way to get an empty scope. The acknowledgement is checked again here rather than
 * trusted from config, for the same reason `execute.ts` re-validates a setting name.
 */
export function unscopedReadScope(acknowledge: string, identity: string): ReadScope {
  if (acknowledge !== SINGLE_TENANT_ACKNOWLEDGEMENT) {
    throw new TypeError(
      `an unscoped read requires the exact acknowledgement ${JSON.stringify(SINGLE_TENANT_ACKNOWLEDGEMENT)}`,
    );
  }
  return mint([], identity, true);
}

export const isReadScope = (value: unknown): value is ReadScope =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<symbol, unknown>)[SCOPE_BRAND] === true &&
  Array.isArray((value as { settings?: unknown }).settings);

export type ScopeOutcome =
  | { readonly ok: true; readonly scope: ReadScope }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 500;
      readonly detail: string;
      readonly cause?: unknown;
    };

export function assertTenancy(tenancy: TenancyConfig | undefined): TenancyConfig {
  if (tenancy === undefined || tenancy === null) {
    throw new TypeError(
      'tenancy is required: pass multiTenant(resolver) or singleTenant(SINGLE_TENANT_ACKNOWLEDGEMENT)',
    );
  }
  if (tenancy.mode === 'single') {
    unscopedReadScope(tenancy.acknowledge, 'config');
    return tenancy;
  }
  if (tenancy.mode !== 'multi' || typeof tenancy.resolve !== 'function') {
    throw new TypeError('multi-tenant mode needs a resolve(token) function');
  }
  return tenancy;
}

export async function resolveScope(
  tenancy: TenancyConfig,
  token: string | null,
  fallbackIdentity: string,
): Promise<ScopeOutcome> {
  if (tenancy.mode === 'single') {
    return { ok: true, scope: unscopedReadScope(tenancy.acknowledge, fallbackIdentity) };
  }
  if (token === null || token === '') {
    return { ok: false, status: 401, detail: 'no bearer token was presented' };
  }
  try {
    return { ok: true, scope: tenantReadScope(await tenancy.resolve(token)) };
  } catch (err) {
    if (isIdentityError(err)) {
      const status = err.failure === 'authentication' ? 401 : err.failure === 'authorization' ? 403 : 500;
      return { ok: false, status, detail: `${err.code}: ${err.message}`, cause: err };
    }
    return { ok: false, status: 500, detail: 'the scope resolver threw', cause: err };
  }
}

/**
 * The single call site of `runGuardedRead` in this package. A `ReadScope` is not optional and
 * cannot be fabricated, so the fail-open ADR 0013 describes is closed by construction here.
 */
export async function runScopedRead(
  source: ReaderSource,
  query: GuardedQuery,
  scope: ReadScope,
  options: ReadOptions = {},
): Promise<ReadResult> {
  if (!isReadScope(scope)) {
    throw new TypeError('a read needs a scope produced by tenantReadScope or unscopedReadScope');
  }
  if (scope.settings.length === 0 && !scope.unscoped) {
    throw new TypeError('refusing an empty scope that was not declared single-tenant');
  }
  return runGuardedRead(source, query, { ...options, scope: scope.settings });
}
