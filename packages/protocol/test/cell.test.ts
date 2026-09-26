import { describe, expect, it } from 'vitest';
import type { Cell } from '../src/index.js';
import { cellSchema, parseCell, parseResultSet, resultSetSchema } from '../src/index.js';

const accepts = (value: unknown): boolean => cellSchema.safeParse(value).success;

describe('cell values', () => {
  it('accepts the four scalar shapes a column can hold', () => {
    expect(accepts('2026-09-05')).toBe(true);
    expect(accepts(42)).toBe(true);
    expect(accepts(-1.5)).toBe(true);
    expect(accepts(true)).toBe(true);
    expect(accepts(null)).toBe(true);
  });

  it('accepts nested json for json and jsonb columns', () => {
    expect(accepts({ plan: 'pro', seats: [1, 2, 3] })).toBe(true);
    expect(accepts([{ a: { b: [null, false, 'x'] } }])).toBe(true);
    expect(accepts({})).toBe(true);
    expect(accepts([])).toBe(true);
  });

  it('rejects a Date, at every depth', () => {
    expect(accepts(new Date('2026-09-05T00:00:00Z'))).toBe(false);
    expect(accepts([new Date()])).toBe(false);
    expect(accepts({ created: new Date() })).toBe(false);
    expect(accepts({ a: { b: [new Date()] } })).toBe(false);
  });

  it('rejects a Date inside a result set row', () => {
    const parsed = parseResultSet({ columns: ['day'], rows: [[new Date('2026-09-05T00:00:00Z')]] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]?.path).toBe('rows.0.0');
  });

  it('rejects values JSON.stringify would silently rewrite', () => {
    expect(accepts(Number.NaN)).toBe(false);
    expect(accepts(Number.POSITIVE_INFINITY)).toBe(false);
    expect(accepts(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(accepts(10n)).toBe(false);
    expect(accepts(undefined)).toBe(false);
    expect(accepts({ a: undefined })).toBe(false);
    expect(accepts(() => 1)).toBe(false);
    expect(accepts(new Map())).toBe(false);
  });

  it('parseCell reports rather than throws', () => {
    const parsed = parseCell(new Date());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
  });
});

describe('result sets', () => {
  it('parses columns and array rows', () => {
    const parsed = parseResultSet({
      columns: ['signup_method', 'users'],
      rows: [
        ['google', 12],
        ['email', 7],
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.rows[1]?.[0]).toBe('email');
  });

  it('keeps duplicate column names, which is why rows are arrays', () => {
    const parsed = parseResultSet({ columns: ['id', 'id'], rows: [[1, 2]] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.columns).toEqual(['id', 'id']);
  });

  it('rejects a row that does not hold one cell per column', () => {
    expect(resultSetSchema.safeParse({ columns: ['a', 'b'], rows: [[1]] }).success).toBe(false);
    expect(resultSetSchema.safeParse({ columns: ['a'], rows: [[1, 2]] }).success).toBe(false);
  });

  it('accepts an empty result', () => {
    expect(resultSetSchema.safeParse({ columns: ['a'], rows: [] }).success).toBe(true);
  });

  it('rejects object rows', () => {
    expect(resultSetSchema.safeParse({ columns: ['a'], rows: [{ a: 1 }] }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const parsed = parseResultSet({ columns: ['a'], rows: [[1]], rowCount: 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('rowCount');
  });
});

const _dateIsNotACell: Date extends Cell ? never : true = true;
const _nestedJsonIsACell: { a: [number, null] } extends Cell ? true : never = true;
void _dateIsNotACell;
void _nestedJsonIsACell;
