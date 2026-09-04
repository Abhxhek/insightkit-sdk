import { describe, expect, it } from 'vitest';
import { resultSetsEqual } from '../src/compare.js';
import type { CompareOptions, ResultSet } from '../src/types.js';

const rs = (columns: string[], rows: unknown[][]): ResultSet => ({ columns, rows });
const unordered: CompareOptions = { orderSensitive: false };
const ordered: CompareOptions = { orderSensitive: true };

describe('resultSetsEqual', () => {
  it('accepts identical result sets', () => {
    const a = rs(
      ['month', 'signups'],
      [
        ['2026-01', 10],
        ['2026-02', 12],
      ],
    );
    expect(resultSetsEqual(a, a, ordered).equal).toBe(true);
  });

  it('ignores column names, comparing positionally', () => {
    const a = rs(['month', 'signups'], [['2026-01', 10]]);
    const b = rs(['bucket', 'n'], [['2026-01', 10]]);
    expect(resultSetsEqual(a, b, ordered).equal).toBe(true);
  });

  it('treats row order as irrelevant when the question does not order', () => {
    const a = rs(
      ['plan', 'mrr'],
      [
        ['pro', 100],
        ['free', 0],
      ],
    );
    const b = rs(
      ['plan', 'mrr'],
      [
        ['free', 0],
        ['pro', 100],
      ],
    );
    expect(resultSetsEqual(a, b, unordered).equal).toBe(true);
    expect(resultSetsEqual(a, b, ordered).equal).toBe(false);
  });

  it('does NOT collapse duplicate rows', () => {
    const a = rs(['name'], [['ada'], ['ada']]);
    const b = rs(['name'], [['ada'], ['grace']]);
    const r = resultSetsEqual(a, b, unordered);
    expect(r.equal).toBe(false);
    if (!r.equal) expect(r.reason).toContain('unmatched');
  });

  it('counts duplicates rather than testing membership', () => {
    const a = rs(['n'], [[1], [1], [2]]);
    const b = rs(['n'], [[1], [2], [2]]);
    expect(resultSetsEqual(a, b, unordered).equal).toBe(false);
  });

  it('tolerates floating point drift within the significant-digit budget', () => {
    const a = rs(['total'], [[1249.9999999998]]);
    const b = rs(['total'], [[1250.0]]);
    expect(resultSetsEqual(a, b, unordered).equal).toBe(true);
    expect(resultSetsEqual(rs(['t'], [[0.1 + 0.2]]), rs(['t'], [[0.3]]), unordered).equal).toBe(true);
  });

  it('still separates genuinely different numbers', () => {
    expect(resultSetsEqual(rs(['t'], [[1250]]), rs(['t'], [[1251]]), unordered).equal).toBe(false);
    expect(resultSetsEqual(rs(['t'], [[1.0001]]), rs(['t'], [[1.0002]]), unordered).equal).toBe(false);
  });

  it('coerces numeric strings, because pg returns bigint and numeric as text', () => {
    expect(resultSetsEqual(rs(['n'], [['42']]), rs(['n'], [[42]]), unordered).equal).toBe(true);
    expect(resultSetsEqual(rs(['n'], [['1250.00']]), rs(['n'], [[1250]]), unordered).equal).toBe(true);
  });

  it('can be told not to coerce numeric strings', () => {
    const strict: CompareOptions = { orderSensitive: false, numericStrings: 'strict' };
    expect(resultSetsEqual(rs(['n'], [['42']]), rs(['n'], [[42]]), strict).equal).toBe(false);
  });

  it('distinguishes NULL from the string "null" and from zero', () => {
    expect(resultSetsEqual(rs(['v'], [[null]]), rs(['v'], [['null']]), unordered).equal).toBe(false);
    expect(resultSetsEqual(rs(['v'], [[null]]), rs(['v'], [[0]]), unordered).equal).toBe(false);
    expect(resultSetsEqual(rs(['v'], [[null]]), rs(['v'], [[null]]), unordered).equal).toBe(true);
  });

  it('treats undefined as NULL', () => {
    expect(resultSetsEqual(rs(['v'], [[undefined]]), rs(['v'], [[null]]), unordered).equal).toBe(true);
  });

  it('compares jsonb regardless of key order', () => {
    const a = rs(['props'], [[{ b: 1, a: 2 }]]);
    const b = rs(['props'], [[{ a: 2, b: 1 }]]);
    expect(resultSetsEqual(a, b, unordered).equal).toBe(true);
  });

  it('compares timestamps by instant', () => {
    const a = rs(['t'], [[new Date('2026-01-01T00:00:00Z')]]);
    const b = rs(['t'], [[new Date('2026-01-01T00:00:00.000Z')]]);
    expect(resultSetsEqual(a, b, unordered).equal).toBe(true);
  });

  it('reports a column count mismatch with both shapes', () => {
    const r = resultSetsEqual(rs(['a'], [[1]]), rs(['a', 'b'], [[1, 2]]), unordered);
    expect(r.equal).toBe(false);
    if (!r.equal) expect(r.reason).toContain('column count');
  });

  it('reports a row count mismatch', () => {
    const r = resultSetsEqual(rs(['a'], [[1]]), rs(['a'], [[1], [2]]), unordered);
    expect(r.equal).toBe(false);
    if (!r.equal) expect(r.reason).toContain('row count');
  });

  it('rejects a ragged row rather than comparing it', () => {
    const r = resultSetsEqual(rs(['a', 'b'], [[1]]), rs(['a', 'b'], [[1, 2]]), unordered);
    expect(r.equal).toBe(false);
    if (!r.equal) expect(r.reason).toContain('cells');
  });

  it('is injective across cell boundaries', () => {
    const a = rs(['x', 'y'], [['a|s:b', 'c']]);
    const b = rs(['x', 'y'], [['a', 'b|s:c']]);
    expect(resultSetsEqual(a, b, unordered).equal).toBe(false);
  });

  it('accepts two empty result sets of the same shape', () => {
    expect(resultSetsEqual(rs(['a'], []), rs(['a'], []), unordered).equal).toBe(true);
  });

  it('names the offending row when order matters', () => {
    const a = rs(['n'], [[1], [3]]);
    const b = rs(['n'], [[1], [2]]);
    const r = resultSetsEqual(a, b, ordered);
    expect(r.equal).toBe(false);
    if (!r.equal) expect(r.reason).toContain('row 1');
  });
});
