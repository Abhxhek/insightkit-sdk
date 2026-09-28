import type { DenyCode } from '@insightkit/sql-guard';
import type { ForeignKey, TableInfo } from '../introspect/types.js';
import type { ChartSpec } from '../plan/types.js';
import type { Glossary } from '../semantic/types.js';
import type { GuardedQuery } from '../types.js';

export type StoreErrorCode =
  | 'E_CONFIG'
  | 'E_NOT_MIGRATED'
  | 'E_NOT_APPROVED'
  | 'E_ENTRY_TOO_LARGE'
  | 'E_MIGRATION_CHECKSUM'
  | 'E_MIGRATION_AHEAD';

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreError';
    this.code = code;
  }
}

export const isStoreError = (err: unknown): err is StoreError => err instanceof StoreError;

/** Everything that determined the plan. Change any of it and the cached plan is a different query. */
export interface CacheKeyInput {
  readonly question: string;
  /** The tables retrieval actually put in front of the model, not the whole database. */
  readonly tables: readonly TableInfo[];
  readonly foreignKeys?: readonly ForeignKey[];
  readonly glossary?: Glossary | null;
  /** Bump to discard every entry: a prompt edit, a model swap, a planner change. */
  readonly plannerVersion?: string;
  readonly maxRows?: number | null;
  readonly guidance?: string | null;
}

export interface CacheKey {
  readonly key: string;
  /** The normalised question the key was taken over, which is what gets stored. */
  readonly question: string;
  readonly schemaDigest: string;
  readonly glossaryDigest: string;
  readonly plannerVersion: string;
}

export interface SavePlanInput {
  readonly key: CacheKeyInput;
  /** Only `approve` produces one, so unguarded SQL cannot be written either. */
  readonly query: GuardedQuery;
  readonly chart: ChartSpec;
  /** Audit only, never part of the key: a plan is schema-shaped, not tenant-shaped. */
  readonly tenantId?: string | null;
}

export interface SavedPlan {
  readonly key: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface CachedPlan {
  readonly key: string;
  readonly question: string;
  /** The guard's re-emitted SQL from this lookup, never the text held in the table. */
  readonly sql: string;
  readonly query: GuardedQuery;
  readonly chart: ChartSpec;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly hitCount: number;
  readonly expiresAt: string | null;
}

export type RejectionReason = 'denied' | 'invalid_chart';

/** A stored row that failed re-approval. Nothing legitimate produces one. */
export interface RejectedEntry {
  readonly key: string;
  readonly reason: RejectionReason;
  readonly code: DenyCode | null;
  readonly detail: string;
}
