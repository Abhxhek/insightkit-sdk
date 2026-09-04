import type { CompareOptions, CompareResult, ResultSet } from './types.js';

const DEFAULT_SIGNIFICANT_DIGITS = 6;
const NUMERIC_LITERAL = /^[+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/;

const ok: CompareResult = { equal: true };
const no = (reason: string): CompareResult => ({ equal: false, reason });

const quantise = (n: number, digits: number): string => {
  if (Number.isNaN(n)) return '#nan';
  if (!Number.isFinite(n)) return n > 0 ? '#inf' : '#-inf';
  if (n === 0) return '#0';
  return `#${n.toPrecision(digits)}`;
};

const stableJson = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const rec = v as Record<string, unknown>;
  const body = Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`)
    .join(',');
  return `{${body}}`;
};

const normalise = (v: unknown, digits: number, coerce: boolean): string => {
  if (v === null || v === undefined) return '~';
  if (typeof v === 'number') return quantise(v, digits);
  if (typeof v === 'bigint') return quantise(Number(v), digits);
  if (typeof v === 'boolean') return v ? 'b:1' : 'b:0';
  if (v instanceof Date) return `d:${v.toISOString()}`;
  if (typeof v === 'string')
    return coerce && NUMERIC_LITERAL.test(v) ? quantise(Number(v), digits) : `s:${v}`;
  return `j:${stableJson(v)}`;
};

const rowKey = (row: readonly unknown[], digits: number, coerce: boolean): string =>
  row
    .map((cell) => {
      const s = normalise(cell, digits, coerce);
      return `${s.length}:${s}`;
    })
    .join('');

const describe = (row: readonly unknown[] | undefined): string =>
  row === undefined
    ? '<missing>'
    : `[${row.map((c) => (typeof c === 'string' ? JSON.stringify(c) : String(c))).join(', ')}]`;

export function resultSetsEqual(
  actual: ResultSet,
  expected: ResultSet,
  options: CompareOptions,
): CompareResult {
  const digits = options.significantDigits ?? DEFAULT_SIGNIFICANT_DIGITS;
  const coerce = (options.numericStrings ?? 'coerce') === 'coerce';
  const width = expected.columns.length;

  if (actual.columns.length !== width) {
    return no(
      `column count ${actual.columns.length} != ${width} (got [${actual.columns.join(', ')}], want [${expected.columns.join(', ')}])`,
    );
  }
  if (actual.rows.length !== expected.rows.length) {
    return no(`row count ${actual.rows.length} != ${expected.rows.length}`);
  }
  for (const [label, set] of [
    ['actual', actual],
    ['expected', expected],
  ] as const) {
    for (const [i, row] of set.rows.entries()) {
      if (row.length !== width) return no(`${label} row ${i} has ${row.length} cells, expected ${width}`);
    }
  }

  const a = actual.rows.map((r) => rowKey(r, digits, coerce));
  const b = expected.rows.map((r) => rowKey(r, digits, coerce));

  if (options.orderSensitive) {
    for (const [i, key] of a.entries()) {
      if (key !== b[i]) {
        return no(`row ${i} differs: got ${describe(actual.rows[i])}, want ${describe(expected.rows[i])}`);
      }
    }
    return ok;
  }

  const remaining = new Map<string, number>();
  for (const key of b) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  const unmatched: number[] = [];
  for (const [i, key] of a.entries()) {
    const count = remaining.get(key) ?? 0;
    if (count === 0) unmatched.push(i);
    else remaining.set(key, count - 1);
  }
  if (unmatched.length > 0) {
    const first = unmatched[0] ?? 0;
    const missingIndex = b.findIndex((key) => (remaining.get(key) ?? 0) > 0);
    return no(
      `${unmatched.length} row(s) unmatched as a multiset; got ${describe(actual.rows[first])}, ` +
        `expected row with no match in actual: ${describe(expected.rows[missingIndex])}`,
    );
  }
  return ok;
}
