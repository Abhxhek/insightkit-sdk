import type { DenyCode } from './types.js';

export type LimitReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'static'; readonly value: number }
  | { readonly kind: 'dynamic' };

type Select = Record<string, unknown>;

export function readLimit(node: unknown): LimitReading {
  if (node === null || node === undefined) return { kind: 'none' };
  if (typeof node !== 'object') return { kind: 'dynamic' };
  const konst = (node as { A_Const?: Record<string, unknown> }).A_Const;
  if (konst === undefined) return { kind: 'dynamic' };
  if (konst.isnull === true) return { kind: 'none' };

  // libpg_query omits protobuf defaults, so LIMIT 0 arrives as an empty ival object.
  const ival = konst.ival as { ival?: number } | undefined;
  if (ival !== undefined && typeof ival === 'object') return { kind: 'static', value: ival.ival ?? 0 };

  const fval = konst.fval as { fval?: string } | undefined;
  if (fval?.fval !== undefined) {
    const n = Number(fval.fval);
    return Number.isFinite(n) ? { kind: 'static', value: n } : { kind: 'dynamic' };
  }
  return { kind: 'dynamic' };
}

export function effectiveLimit(select: Select): LimitReading {
  return readLimit(select.limitCount);
}

export type CapOutcome =
  | { readonly ok: true; readonly limit: number; readonly clamped: boolean }
  | { readonly ok: false; readonly code: DenyCode; readonly detail: string };

export function applyRowCap(select: Select, maxRows: number): CapOutcome {
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    return { ok: false, code: 'E_INTERNAL', detail: `maxRows must be a positive integer, got ${maxRows}` };
  }
  if (select.limitOption === 'LIMIT_OPTION_WITH_TIES') {
    return {
      ok: false,
      code: 'E_LIMIT_NOT_ENFORCEABLE',
      detail: 'WITH TIES can return more rows than its count, so a row cap cannot be guaranteed',
    };
  }

  const existing = readLimit(select.limitCount);
  if (existing.kind === 'dynamic') {
    return {
      ok: false,
      code: 'E_LIMIT_NOT_STATIC',
      detail: 'LIMIT is not a literal integer, so it cannot be compared against the row cap',
    };
  }
  if (existing.kind === 'static' && existing.value <= maxRows) {
    return { ok: true, limit: existing.value, clamped: false };
  }

  select.limitOption = 'LIMIT_OPTION_COUNT';
  select.limitCount = { A_Const: { ival: { ival: maxRows } } };
  return { ok: true, limit: maxRows, clamped: true };
}
