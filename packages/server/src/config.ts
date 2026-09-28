import type {
  DatabaseSchema,
  Glossary,
  GlossaryReport,
  ModelProvider,
  ReaderSource,
  ReadOptions,
  RetrieveOptions,
  ScopeResolver,
  ScopeResolverConfig,
} from '@insightkit/core';
import { createScopeResolver, defineGlossary, validateGlossary } from '@insightkit/core';
import { MAX_STREAM_INTERVAL_MS, MIN_STREAM_INTERVAL_MS } from '@insightkit/protocol';
import { bearerToken } from './http.js';
import type { Limiter, LimitsRuntime } from './limits.js';
import { createLimiter, limitsRuntime } from './limits.js';
import { assertTenancy } from './scope.js';
import { createMemoryStreamStore } from './store.js';
import type {
  Guard,
  InsightKitConfig,
  LiveConfig,
  MultiTenant,
  PlanTuning,
  ServerError,
  ServerSecurityEvent,
  SINGLE_TENANT_ACKNOWLEDGEMENT,
  SingleTenant,
  StreamStore,
  TenancyConfig,
} from './types.js';

export const multiTenant = (resolve: ScopeResolver): MultiTenant => ({ mode: 'multi', resolve });

export async function multiTenantFromJwt(config: ScopeResolverConfig): Promise<MultiTenant> {
  return multiTenant(await createScopeResolver(config));
}

export const singleTenant = (acknowledge: typeof SINGLE_TENANT_ACKNOWLEDGEMENT): SingleTenant => ({
  mode: 'single',
  acknowledge,
});

export interface LiveRuntime {
  readonly minIntervalMs: number;
  readonly defaultIntervalMs: number;
  readonly maxIntervalMs: number;
  readonly tokenTtlMs: number;
  readonly maxDurationMs: number;
  readonly keepaliveMs: number;
  readonly maxPerIdentity: number;
  readonly maxTotal: number;
  readonly maxConsecutiveErrors: number;
  readonly store: StreamStore;
}

export const LIVE_DEFAULTS = {
  minIntervalMs: 5_000,
  defaultIntervalMs: 15_000,
  maxIntervalMs: MAX_STREAM_INTERVAL_MS,
  tokenTtlMs: 900_000,
  maxDurationMs: 1_800_000,
  keepaliveMs: 15_000,
  maxPerIdentity: 4,
  maxTotal: 200,
  maxConsecutiveErrors: 3,
} as const;

export interface Runtime {
  readonly source: ReaderSource;
  readonly guard: Guard;
  readonly provider: ModelProvider;
  readonly schema: () => Promise<DatabaseSchema>;
  readonly tenancy: TenancyConfig;
  /** Vetted against the schema the first time it is seen; a broken entry is dropped, not sent. */
  readonly glossary: (schema: DatabaseSchema) => Glossary | null;
  readonly checkGlossary: (schema: DatabaseSchema) => GlossaryReport | null;
  readonly exposeSql: boolean;
  readonly live: LiveRuntime | null;
  readonly limits: LimitsRuntime;
  readonly limiter: Limiter;
  readonly plan: PlanTuning;
  readonly retrieve: RetrieveOptions;
  readonly read: ReadOptions;
  readonly routes: { readonly ask: string; readonly subscribe: string };
  readonly tokenFrom: (request: Request) => string | null;
  readonly identify: (request: Request) => string | null;
  readonly now: () => number;
  readonly onSecurityEvent: ((event: ServerSecurityEvent) => void) | null;
  readonly onError: (error: ServerError) => void;
}

const count = (value: number | undefined, fallback: number, what: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${what} must be a positive number`);
  return value;
};

function schemaLoader(config: InsightKitConfig): () => Promise<DatabaseSchema> {
  const source = config.schema;
  if (source === undefined) throw new TypeError('schema is required: pass a DatabaseSchema or a loader');
  if (typeof source !== 'function') return async () => source;

  const ttl = config.schemaTtlMs ?? 0;
  if (!Number.isFinite(ttl) || ttl < 0) throw new RangeError('schemaTtlMs must be zero or more');
  if (ttl === 0) return async () => source();

  let cached: { at: number; value: Promise<DatabaseSchema> } | null = null;
  return async () => {
    const now = (config.now ?? Date.now)();
    if (cached !== null && now - cached.at < ttl) return cached.value;
    const value = Promise.resolve(source()).catch((err: unknown) => {
      cached = null;
      throw err;
    });
    cached = { at: now, value };
    return value;
  };
}

/**
 * A definition in a prompt is more authoritative to a model than silence, so an entry naming a
 * column that is not there is worse than no entry at all. Errors drop the entry and reach the host.
 */
function glossaryGate(
  glossary: Glossary | undefined,
  onError: (error: ServerError) => void,
): {
  use: (schema: DatabaseSchema) => Glossary | null;
  check: (schema: DatabaseSchema) => GlossaryReport | null;
} {
  if (glossary === undefined) return { use: () => null, check: () => null };

  let against: DatabaseSchema | null = null;
  let vetted: Glossary | null = null;
  let report: GlossaryReport | null = null;

  const run = (schema: DatabaseSchema): GlossaryReport => {
    if (against === schema && report !== null) return report;
    against = schema;
    report = validateGlossary(glossary, schema);
    const broken = new Set(report.problems.filter((p) => p.severity === 'error').map((p) => p.entry));
    if (report.problems.length > 0) {
      const detail = report.problems.map((p) => `${p.code} on ${JSON.stringify(p.term)}`).join('; ');
      onError({ phase: 'schema', identity: null, error: new Error(`glossary: ${detail}`) });
    }
    vetted = broken.size === 0 ? glossary : defineGlossary(glossary.entries.filter((_, i) => !broken.has(i)));
    return report;
  };

  return {
    use: (schema) => {
      run(schema);
      return vetted;
    },
    check: (schema) => run(schema),
  };
}

function liveRuntime(config: LiveConfig): LiveRuntime {
  const minIntervalMs = count(config.minIntervalMs, LIVE_DEFAULTS.minIntervalMs, 'minIntervalMs');
  const maxIntervalMs = count(config.maxIntervalMs, LIVE_DEFAULTS.maxIntervalMs, 'maxIntervalMs');
  if (maxIntervalMs < minIntervalMs) throw new RangeError('maxIntervalMs is below minIntervalMs');
  const maxPerIdentity = count(config.maxPerIdentity, LIVE_DEFAULTS.maxPerIdentity, 'maxPerIdentity');
  const maxTotal = count(config.maxTotal, LIVE_DEFAULTS.maxTotal, 'maxTotal');
  return {
    minIntervalMs,
    maxIntervalMs,
    defaultIntervalMs: Math.min(
      maxIntervalMs,
      Math.max(
        minIntervalMs,
        count(config.defaultIntervalMs, LIVE_DEFAULTS.defaultIntervalMs, 'defaultIntervalMs'),
      ),
    ),
    tokenTtlMs: count(config.tokenTtlMs, LIVE_DEFAULTS.tokenTtlMs, 'tokenTtlMs'),
    maxDurationMs: count(config.maxDurationMs, LIVE_DEFAULTS.maxDurationMs, 'maxDurationMs'),
    keepaliveMs: count(config.keepaliveMs, LIVE_DEFAULTS.keepaliveMs, 'keepaliveMs'),
    maxPerIdentity,
    maxTotal,
    maxConsecutiveErrors: count(
      config.maxConsecutiveErrors,
      LIVE_DEFAULTS.maxConsecutiveErrors,
      'maxConsecutiveErrors',
    ),
    store: config.store ?? createMemoryStreamStore({ maxTotal, maxPerIdentity }),
  };
}

const route = (name: string | undefined, fallback: string): string => {
  const value = (name ?? fallback).trim();
  if (value === '' || value.includes('/'))
    throw new RangeError(`route ${JSON.stringify(name)} must be one segment`);
  return value;
};

export function createRuntime(config: InsightKitConfig): Runtime {
  if (config === undefined || config === null) throw new TypeError('createInsightKit needs a configuration');
  const tenancy = assertTenancy(config.tenancy);
  if (typeof config.guard !== 'function') throw new TypeError('guard is required');
  if (config.source === undefined) throw new TypeError('source is required');
  if (config.provider === undefined) throw new TypeError('provider is required');

  const limits = limitsRuntime(config.limits ?? {});
  const onError = config.onError;
  const report = (error: ServerError): void => {
    if (onError === undefined) return;
    try {
      onError(error);
    } catch {
      /* a host reporter must not fail the request it reports on */
    }
  };
  const glossary = glossaryGate(config.glossary, report);

  return {
    source: config.source,
    guard: config.guard,
    provider: config.provider,
    schema: schemaLoader(config),
    tenancy,
    glossary: glossary.use,
    checkGlossary: glossary.check,
    exposeSql: config.exposeSql === true,
    live: config.live === false || config.live === undefined ? null : liveRuntime(config.live),
    limits,
    limiter: createLimiter(limits),
    plan: config.plan ?? {},
    retrieve: config.retrieve ?? {},
    read: config.read ?? {},
    routes: {
      ask: route(config.routes?.ask, 'ask'),
      subscribe: route(config.routes?.subscribe, 'subscribe'),
    },
    tokenFrom: config.tokenFrom ?? bearerToken,
    identify: config.identify ?? (() => null),
    now: config.now ?? Date.now,
    onSecurityEvent: config.onSecurityEvent ?? null,
    onError: report,
  };
}

/** Clamped server-side: the protocol bounds what a client may ask for, this bounds what it gets. */
export function clampInterval(live: LiveRuntime, asked: number | undefined): number {
  const wanted = asked ?? live.defaultIntervalMs;
  const bounded = Math.min(live.maxIntervalMs, Math.max(live.minIntervalMs, wanted));
  return Math.max(1, Math.round(bounded));
}

export const PROTOCOL_INTERVAL_BOUNDS = { min: MIN_STREAM_INTERVAL_MS, max: MAX_STREAM_INTERVAL_MS } as const;
