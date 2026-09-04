import { describe, expect, it } from 'vitest';
import { astEquivalent, POSITIONAL_FIELDS } from '../src/fidelity.js';

describe('astEquivalent', () => {
  it('ignores character offsets that shift when whitespace changes', () => {
    const a = { A_Expr: { name: 'in', location: 32, rexpr_list_start: 32, rexpr_list_end: 40 } };
    const b = { A_Expr: { name: 'in', location: 34, rexpr_list_start: 34, rexpr_list_end: 43 } };
    expect(astEquivalent(a, b).equal).toBe(true);
  });

  it('does not ignore semantic numbers that happen to sit beside offsets', () => {
    const a = { FuncCall: { frameOptions: 1058, location: 7 } };
    const b = { FuncCall: { frameOptions: 530, location: 9 } };
    expect(astEquivalent(a, b).equal).toBe(false);
  });

  it('ignores key order but not key presence', () => {
    expect(astEquivalent({ a: 1, b: 2 }, { b: 2, a: 1 }).equal).toBe(true);
    expect(astEquivalent({ a: 1 }, { a: 1, b: 2 }).equal).toBe(false);
  });

  it('compares arrays by position', () => {
    expect(astEquivalent([1, 2], [2, 1]).equal).toBe(false);
  });

  it('reports a positional-looking field that is not on the allowlist', () => {
    const r = astEquivalent({ Node: { stmt_start: 1 } }, { Node: { stmt_start: 1 } });
    expect(r.unknownPositional).toEqual(['stmt_start']);
  });

  it('reports nothing unknown for the fields we have already reviewed', () => {
    const node = Object.fromEntries([...POSITIONAL_FIELDS].map((f) => [f, 1]));
    expect(astEquivalent(node, node).unknownPositional).toEqual([]);
  });

  it('strips a field it does not recognise only after reporting it', () => {
    const r = astEquivalent({ x: { stmt_end: 1 } }, { x: { stmt_end: 999 } });
    expect(r.unknownPositional).toEqual(['stmt_end']);
    expect(r.equal).toBe(false);
  });
});
