import type { CaseResult, Tier } from './types.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CONCURRENCY = 5;
const TRANSIENT =
  /\b(?:timeout|timed out|econnreset|econnrefused|etimedout|429|5\d\d|rate[ _-]?limit|overloaded)\b/i;

export const isTransientByMessage = (e: unknown): boolean =>
  TRANSIENT.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));

export interface CaseInput {
  readonly id: string;
  readonly tier: Tier;
}

export interface CaseOutcome {
  readonly status: 'PASS' | 'FAIL';
  readonly sql: string;
  readonly costUsd: number;
  readonly detail?: string;
}

export interface RunnerDeps<C extends CaseInput> {
  readonly run: (input: C) => Promise<CaseOutcome>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly isTransient?: (e: unknown) => boolean;
  readonly maxAttempts?: number;
}

export async function runCase<C extends CaseInput>(input: C, deps: RunnerDeps<C>): Promise<CaseResult> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const transient = deps.isTransient ?? isTransientByMessage;
  let last: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const outcome = await deps.run(input);
      return outcome.detail === undefined
        ? {
            id: input.id,
            tier: input.tier,
            status: outcome.status,
            sql: outcome.sql,
            costUsd: outcome.costUsd,
          }
        : {
            id: input.id,
            tier: input.tier,
            status: outcome.status,
            sql: outcome.sql,
            costUsd: outcome.costUsd,
            detail: outcome.detail,
          };
    } catch (e) {
      last = e;
      if (!transient(e) || attempt === maxAttempts) break;
      await deps.sleep(300 * 2 ** attempt);
    }
  }
  return {
    id: input.id,
    tier: input.tier,
    status: 'INFRA_ERROR',
    detail: last instanceof Error ? `${last.name}: ${last.message}` : String(last),
  };
}

export interface CorpusRunOptions {
  readonly concurrency?: number;
  readonly spendCapUsd?: number;
}

export interface CorpusRun {
  readonly results: readonly CaseResult[];
  readonly spendCapExceeded: boolean;
  readonly totalCostUsd: number;
}

export async function runCorpus<C extends CaseInput>(
  cases: readonly C[],
  deps: RunnerDeps<C>,
  options: CorpusRunOptions = {},
): Promise<CorpusRun> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const cap = options.spendCapUsd;
  const results: CaseResult[] = new Array(cases.length);
  let cursor = 0;
  let spent = 0;
  let aborted = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const input = cases[index];
      if (input === undefined) return;
      if (aborted) {
        results[index] = { id: input.id, tier: input.tier, status: 'SKIPPED_CAP' };
        continue;
      }
      const result = await runCase(input, deps);
      results[index] = result;
      spent += result.costUsd ?? 0;
      if (cap !== undefined && spent >= cap) aborted = true;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return { results, spendCapExceeded: aborted, totalCostUsd: spent };
}
