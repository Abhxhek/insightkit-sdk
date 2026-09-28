import type {
  DatabaseSchema,
  Glossary,
  GlossaryReport,
  GuardedQuery,
  ModelProvider,
  PlanDeps,
  ReaderSource,
  ReadOptions,
  RetrieveOptions,
  ScopeResolver,
  SecurityEvent,
} from '@insightkit/core';

/** Taken off core's own dependency shape, because `server` does not depend on `sql-guard`. */
export type Guard = PlanDeps['guard'];

/**
 * The single-tenant escape hatch is a sentence rather than a boolean so that it reads as
 * what it means at the call site and greps as one string across a codebase.
 */
export const SINGLE_TENANT_ACKNOWLEDGEMENT = 'every user of this app may read every row';

export interface MultiTenant {
  readonly mode: 'multi';
  /** `createScopeResolver` from core, or any function from a bearer token to a scope. */
  readonly resolve: ScopeResolver;
}

export interface SingleTenant {
  readonly mode: 'single';
  readonly acknowledge: typeof SINGLE_TENANT_ACKNOWLEDGEMENT;
}

export type TenancyConfig = MultiTenant | SingleTenant;

export type SchemaSource = DatabaseSchema | (() => DatabaseSchema | Promise<DatabaseSchema>);

export interface PlanTuning {
  readonly maxAttempts?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly guidance?: string;
}

export interface LiveConfig {
  /** The real floor. Protocol bounds what a client may ask for; this bounds what it gets. */
  readonly minIntervalMs?: number;
  readonly defaultIntervalMs?: number;
  readonly maxIntervalMs?: number;
  readonly tokenTtlMs?: number;
  readonly maxDurationMs?: number;
  readonly keepaliveMs?: number;
  readonly maxPerIdentity?: number;
  readonly maxTotal?: number;
  readonly maxConsecutiveErrors?: number;
  readonly store?: StreamStore;
}

export interface LimitsConfig {
  readonly maxBodyBytes?: number;
  readonly maxConcurrentPerIdentity?: number;
  readonly maxConcurrent?: number;
  readonly questionsPerMinute?: number;
  readonly burst?: number;
  /** Attack-shaped denials within the window before an identity is put in a cooldown. */
  readonly securityStrikes?: number;
  readonly strikeWindowMs?: number;
  readonly blockMs?: number;
  readonly maxTrackedIdentities?: number;
}

export interface RouteNames {
  readonly ask?: string;
  readonly subscribe?: string;
}

export interface ServerSecurityEvent extends SecurityEvent {
  /** The tenant id in multi-tenant mode, or whatever `identify` returned. */
  readonly identity: string;
  readonly at: number;
  /** True when this strike put the identity into a cooldown. */
  readonly throttled: boolean;
}

export type ServerErrorPhase = 'auth' | 'schema' | 'plan' | 'read' | 'respond' | 'stream' | 'store';

export interface ServerError {
  readonly phase: ServerErrorPhase;
  readonly identity: string | null;
  readonly error: unknown;
}

export interface StreamRecord {
  readonly token: string;
  readonly identity: string;
  readonly query: GuardedQuery;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * Deliberately holds the branded query rather than SQL text: an out-of-process store must
 * re-run `approve` on the way back out, so nothing can be revived that the guard has not seen.
 */
export interface StreamStore {
  issue(record: StreamRecord): void;
  get(token: string, now: number): StreamRecord | undefined;
  revoke(token: string): void;
  countFor(identity: string, now: number): number;
  sweep(now: number): void;
}

export interface InsightKitConfig {
  readonly source: ReaderSource;
  readonly guard: Guard;
  readonly provider: ModelProvider;
  readonly schema: SchemaSource;
  /** Memoise a schema loader for this long. 0, the default, calls it on every question. */
  readonly schemaTtlMs?: number;
  /**
   * Required, and has no default. Leaving it out is a type error, and a JavaScript host
   * that leaves it out is refused at construction rather than served unscoped rows.
   */
  readonly tenancy: TenancyConfig;
  readonly glossary?: Glossary;
  /** Off by default. On, the approved SQL is returned to the browser. See ADR 0012. */
  readonly exposeSql?: boolean;
  readonly live?: LiveConfig | false;
  readonly limits?: LimitsConfig;
  readonly plan?: PlanTuning;
  readonly retrieve?: RetrieveOptions;
  readonly read?: ReadOptions;
  readonly routes?: RouteNames;
  /** Defaults to the `Authorization: Bearer` header. Override for a cookie or a custom scheme. */
  readonly tokenFrom?: (request: Request) => string | null;
  /** The rate-limit bucket before a tenant is known. A Request cannot see a client address. */
  readonly identify?: (request: Request) => string | null;
  readonly onSecurityEvent?: (event: ServerSecurityEvent) => void;
  readonly onError?: (error: ServerError) => void;
  readonly now?: () => number;
}

export interface InsightKitServer {
  readonly ask: (request: Request) => Promise<Response>;
  readonly subscribe: (request: Request) => Promise<Response>;
  /** Routes on the last path segment, so it mounts under any base path. */
  readonly handler: (request: Request) => Promise<Response>;
  /** Call at startup and fail the boot on `ok: false`. Null when no glossary is configured. */
  readonly checkGlossary: () => Promise<GlossaryReport | null>;
  readonly close: () => Promise<void>;
}
