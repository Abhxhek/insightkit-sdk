import type { DenyCode, Guard, Policy } from '@insightkit/sql-guard';
import { approve } from '../approve.js';
import { repairTurn, systemPrompt } from './prompt.js';
import type { ModelMessage, ModelProvider, ModelUsage } from './provider.js';
import { failureKind } from './provider.js';
import type { Selection } from './retrieve.js';
import { PLAN_SCHEMA, readPlan } from './schema.js';
import type { PlanAttempt, PlanOptions, PlanResult, SecurityEvent } from './types.js';
import { addUsage, ZERO_USAGE } from './types.js';

/**
 * Denials a mistake does not produce. A model asked to count users does not reach for
 * DELETE, so these are somebody probing rather than a query worth fixing. Repairing one
 * would hand an attacker an automated loop against the validator, billed to the host.
 */
const ATTACK_SHAPED: ReadonlySet<DenyCode> = new Set(['E_NOT_SELECT', 'E_MULTI_STATEMENT', 'E_NUL_BYTE']);

/** Our own invariant broke. Asking the model again cannot help. */
const OUR_FAULT: ReadonlySet<DenyCode> = new Set(['E_ROUND_TRIP_FAILED', 'E_INTERNAL']);

export const isAttackShaped = (code: DenyCode): boolean => ATTACK_SHAPED.has(code);
export const isRepairable = (code: DenyCode): boolean => !ATTACK_SHAPED.has(code) && !OUR_FAULT.has(code);

export interface PlanDeps {
  readonly guard: Guard;
  readonly provider: ModelProvider;
}

const DEFAULT_MAX_ATTEMPTS = 2;

export async function planQuery(
  deps: PlanDeps,
  question: string,
  selection: Selection,
  options: PlanOptions = {},
): Promise<PlanResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const system = systemPrompt(selection.sql, {
    ...(options.guidance === undefined ? {} : { guidance: options.guidance }),
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
  });
  const policy: Policy | undefined = options.maxRows === undefined ? undefined : { maxRows: options.maxRows };

  // The question is the first user turn rather than part of our instructions, so text
  // asking the model to disregard them is not sitting in the instruction slot.
  const messages: ModelMessage[] = [{ role: 'user', content: question }];
  const attempts: PlanAttempt[] = [];
  let usage: ModelUsage = ZERO_USAGE;

  const raise = (event: SecurityEvent): void => {
    if (options.onSecurityEvent === undefined) return;
    // A host's logger must not be able to fail the request it is reporting on.
    try {
      options.onSecurityEvent(event);
    } catch {
      /* the caller's problem, not this request's */
    }
  };

  const fail = (
    reason: 'unanswerable' | 'rejected' | 'model_error' | 'invalid_plan',
    detail: string,
    code: DenyCode | null,
  ): PlanResult => ({ ok: false, reason, detail, code, attempts, usage });

  for (let n = 1; n <= maxAttempts; n += 1) {
    let output: unknown;
    let attemptUsage: ModelUsage = ZERO_USAGE;
    try {
      const completion = await deps.provider.complete({
        system,
        messages,
        schema: PLAN_SCHEMA,
        ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      output = completion.output;
      attemptUsage = completion.usage;
      usage = addUsage(usage, attemptUsage);
    } catch (err) {
      const kind = failureKind(err);
      const message = err instanceof Error ? err.message : String(err);
      const detail = kind === null ? message : `${kind}: ${message}`;
      attempts.push({ n, sql: null, outcome: 'model_error', code: null, detail, usage: ZERO_USAGE });
      return fail('model_error', detail, null);
    }

    const read = readPlan(output);
    if (!read.ok) {
      attempts.push({
        n,
        sql: null,
        outcome: 'invalid',
        code: null,
        detail: read.detail,
        usage: attemptUsage,
      });
      return fail('invalid_plan', read.detail, null);
    }

    const draft = read.draft;
    if (!draft.answerable || draft.sql === null) {
      const detail = draft.reason ?? 'the schema cannot answer this question';
      attempts.push({ n, sql: null, outcome: 'unanswerable', code: null, detail, usage: attemptUsage });
      return fail('unanswerable', detail, null);
    }

    const approval =
      policy === undefined ? approve(deps.guard, draft.sql) : approve(deps.guard, draft.sql, policy);
    if (approval.ok) {
      attempts.push({
        n,
        sql: draft.sql,
        outcome: 'approved',
        code: null,
        detail: 'approved',
        usage: attemptUsage,
      });
      return {
        ok: true,
        plan: {
          // The guard's re-emitted SQL, never the model's text.
          sql: approval.query.sql,
          query: approval.query,
          chart: draft.chart,
          tables: approval.query.tables,
          attempts,
          usage,
        },
      };
    }

    attempts.push({
      n,
      sql: draft.sql,
      outcome: 'denied',
      code: approval.code,
      detail: approval.detail,
      usage: attemptUsage,
    });

    if (ATTACK_SHAPED.has(approval.code)) {
      raise({ question, sql: draft.sql, code: approval.code, detail: approval.detail });
      return fail('rejected', approval.detail, approval.code);
    }
    if (!isRepairable(approval.code) || n === maxAttempts) {
      return fail('rejected', approval.detail, approval.code);
    }

    messages.push(
      { role: 'assistant', content: JSON.stringify(output) },
      { role: 'user', content: repairTurn(approval.code, approval.detail) },
    );
  }

  return fail('rejected', 'ran out of attempts', null);
}
