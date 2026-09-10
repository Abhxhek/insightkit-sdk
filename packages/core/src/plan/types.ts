import type { DenyCode, TableRef } from '@insightkit/sql-guard';
import type { GuardedQuery } from '../types.js';
import type { ModelUsage } from './provider.js';

export type ChartKind = 'bar' | 'line' | 'area' | 'table' | 'number';

export const CHART_KINDS: readonly ChartKind[] = ['bar', 'line', 'area', 'table', 'number'];

export interface ChartSpec {
  readonly kind: ChartKind;
  readonly x: string | null;
  readonly y: readonly string[];
  readonly series: string | null;
  readonly title: string | null;
}

export type AttemptOutcome = 'approved' | 'denied' | 'unanswerable' | 'invalid' | 'model_error';

export interface PlanAttempt {
  readonly n: number;
  /** What the model produced, before the guard saw it. Null when it produced nothing. */
  readonly sql: string | null;
  readonly outcome: AttemptOutcome;
  readonly code: DenyCode | null;
  readonly detail: string;
  readonly usage: ModelUsage;
}

export interface Plan {
  /** The guard's own re-emitted SQL, not the model's text. */
  readonly sql: string;
  readonly query: GuardedQuery;
  readonly chart: ChartSpec;
  readonly tables: readonly TableRef[];
  readonly attempts: readonly PlanAttempt[];
  readonly usage: ModelUsage;
}

export type PlanFailure =
  /** The model said the schema cannot answer this. */
  | 'unanswerable'
  /** The guard refused, and we either could not or would not try again. */
  | 'rejected'
  /** The provider failed: rate limited, truncated, refused, unreachable. */
  | 'model_error'
  /** The model returned an object that is not a plan. */
  | 'invalid_plan';

export type PlanResult =
  | { readonly ok: true; readonly plan: Plan }
  | {
      readonly ok: false;
      readonly reason: PlanFailure;
      readonly detail: string;
      readonly code: DenyCode | null;
      readonly attempts: readonly PlanAttempt[];
      readonly usage: ModelUsage;
    };

/**
 * Raised when the guard refuses something a mistake does not produce: a write, stacked
 * statements, a NUL byte. Not a failed query — somebody probing the boundary.
 */
export interface SecurityEvent {
  readonly question: string;
  readonly sql: string;
  readonly code: DenyCode;
  readonly detail: string;
}

export interface PlanOptions {
  /** Total tries, including the first. Repair is only offered for honest mistakes. */
  readonly maxAttempts?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  /** Extra instruction appended to the system prompt: business rules, conventions. */
  readonly guidance?: string;
  readonly onSecurityEvent?: (event: SecurityEvent) => void;
}

export const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export const addUsage = (a: ModelUsage, b: ModelUsage): ModelUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});
