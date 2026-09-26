import type { ScopeConfig, TenantScope } from './scope.js';
import { tenantScope } from './scope.js';
import type { TokenVerifierConfig } from './verify.js';
import { createTokenVerifier } from './verify.js';

export interface ScopeResolverConfig {
  readonly token: TokenVerifierConfig;
  readonly scope: ScopeConfig;
}

export type ScopeResolver = (token: string) => Promise<TenantScope>;

export async function createScopeResolver(config: ScopeResolverConfig): Promise<ScopeResolver> {
  const verify = await createTokenVerifier(config.token);
  return async (token: string) => tenantScope((await verify(token)).claims, config.scope);
}
