import type { ChartKind, ChartSpec } from './types.js';
import { CHART_KINDS } from './types.js';

/**
 * Flat rather than nested, and every field required with nulls where inapplicable.
 * Strict structured outputs reject optional properties, and a nullable nested object
 * is the shape providers disagree about most, so the plan is kept one level deep.
 */
export const PLAN_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'answerable',
    'reason',
    'sql',
    'chart_kind',
    'chart_x',
    'chart_y',
    'chart_series',
    'chart_title',
  ],
  properties: {
    answerable: {
      type: 'boolean',
      description: 'False when the described schema cannot answer the question. Never guess.',
    },
    reason: {
      type: ['string', 'null'],
      description: 'When not answerable, one sentence a non-technical person can act on.',
    },
    sql: {
      type: ['string', 'null'],
      description: 'A single read-only PostgreSQL SELECT statement. No semicolon.',
    },
    chart_kind: { type: ['string', 'null'], enum: [...CHART_KINDS, null] },
    chart_x: { type: ['string', 'null'], description: 'Output column for the category or time axis.' },
    chart_y: { type: 'array', items: { type: 'string' }, description: 'Output columns to measure.' },
    chart_series: { type: ['string', 'null'], description: 'Output column to split the series by.' },
    chart_title: { type: ['string', 'null'] },
  },
};

export interface PlanDraft {
  readonly answerable: boolean;
  readonly reason: string | null;
  readonly sql: string | null;
  readonly chart: ChartSpec;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * The provider was asked for this shape and may even have enforced it. It is checked
 * again because a provider's guarantee is not one we made, and this ends in SQL.
 */
export function readPlan(output: unknown): { ok: true; draft: PlanDraft } | { ok: false; detail: string } {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return { ok: false, detail: 'the model returned something that is not a plan object' };
  }
  const o = output as Record<string, unknown>;

  if (typeof o.answerable !== 'boolean') {
    return { ok: false, detail: 'the plan does not say whether the question is answerable' };
  }

  const kindText = str(o.chart_kind);
  const kind: ChartKind =
    kindText !== null && (CHART_KINDS as readonly string[]).includes(kindText)
      ? (kindText as ChartKind)
      : 'table';

  const chart: ChartSpec = {
    kind,
    x: str(o.chart_x),
    y: Array.isArray(o.chart_y) ? o.chart_y.filter((c): c is string => typeof c === 'string') : [],
    series: str(o.chart_series),
    title: str(o.chart_title),
  };

  if (!o.answerable) {
    return {
      ok: true,
      draft: { answerable: false, reason: str(o.reason) ?? 'no reason given', sql: null, chart },
    };
  }

  const sql = str(o.sql);
  if (sql === null) {
    return { ok: false, detail: 'the plan claims to be answerable but carries no SQL' };
  }
  return { ok: true, draft: { answerable: true, reason: null, sql, chart } };
}
