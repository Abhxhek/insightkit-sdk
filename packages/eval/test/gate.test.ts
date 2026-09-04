import { describe, expect, it } from 'vitest';
import { evaluateGate } from '../src/gate.js';
import type { CaseResult, CaseStatus, Tier, TierPolicy } from '../src/types.js';

const POLICIES: TierPolicy[] = [
  { tier: 'T1', floor: 1.0, zeroTolerance: false },
  { tier: 'T2', floor: 0.85, zeroTolerance: false },
  { tier: 'T4', floor: 1.0, zeroTolerance: true },
];

const make = (tier: Tier, statuses: CaseStatus[]): CaseResult[] =>
  statuses.map((status, i) => ({ id: `${tier}-${i}`, tier, status, costUsd: 0.01 }));

const full = (t1: CaseStatus[], t2: CaseStatus[], t4: CaseStatus[]): CaseResult[] => [
  ...make('T1', t1),
  ...make('T2', t2),
  ...make('T4', t4),
];

const P = 'PASS' as const;
const F = 'FAIL' as const;

describe('evaluateGate', () => {
  it('passes when every tier is at or above its floor', () => {
    const r = evaluateGate({ results: full([P, P], [P, P, P, P], [P, P]), policies: POLICIES });
    expect(r.verdict).toBe('PASS');
    expect(r.reasons).toEqual([]);
  });

  it('sums the cost of the run', () => {
    const r = evaluateGate({ results: full([P, P], [P, P], [P]), policies: POLICIES });
    expect(r.totalCostUsd).toBeCloseTo(0.05, 10);
  });

  it('fails a tier below its floor', () => {
    const r = evaluateGate({ results: full([P, F], [P, P, P, P], [P]), policies: POLICIES });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.join(' ')).toContain('T1');
  });

  it('fails the adversarial tier on a single miss', () => {
    const r = evaluateGate({
      results: full([P], Array(20).fill(P), [...Array(19).fill(P), F]),
      policies: POLICIES,
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.join(' ')).toContain('zero tolerance');
  });

  it('excludes infrastructure errors from the denominator', () => {
    const t1: CaseStatus[] = [P, P, P, P, P, P, P, P, P, 'INFRA_ERROR'];
    const r = evaluateGate({
      results: full(t1, [P], [P]),
      policies: POLICIES,
      maxInfraRate: 0.2,
    });
    expect(r.verdict).toBe('PASS');
  });

  it('is inconclusive rather than green when infrastructure errors exceed the cap', () => {
    const t1: CaseStatus[] = [P, P, P, P, P, P, P, P, P, 'INFRA_ERROR'];
    const r = evaluateGate({ results: full(t1, [P], [P]), policies: POLICIES, maxInfraRate: 0.03 });
    expect(r.verdict).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when the spend cap skipped cases', () => {
    const r = evaluateGate({ results: full([P, 'SKIPPED_CAP'], [P], [P]), policies: POLICIES });
    expect(r.verdict).toBe('INCONCLUSIVE');
  });

  it('never reports PASS when the spend cap aborted the run', () => {
    const r = evaluateGate({ results: full([P], [P], [P]), policies: POLICIES, spendCapExceeded: true });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.reasons.join(' ')).toContain('spend cap');
  });

  it('is inconclusive when a tier ran no cases at all', () => {
    const r = evaluateGate({ results: [...make('T1', [P]), ...make('T2', [P])], policies: POLICIES });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.reasons.join(' ')).toContain('no cases ran');
  });

  it('fails on a regression against the baseline even when still above the floor', () => {
    const t2: CaseStatus[] = [P, P, P, P, P, P, P, P, P, F];
    const r = evaluateGate({
      results: full([P], t2, [P]),
      policies: POLICIES,
      baseline: { commit: 'abc', tiers: [{ tier: 'T2', rate: 1.0 }] },
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.join(' ')).toContain('regression');
  });

  it('tolerates a drop inside the regression tolerance', () => {
    const t2: CaseStatus[] = [P, P, P, P, P, P, P, P, P, F];
    const r = evaluateGate({
      results: full([P], t2, [P]),
      policies: POLICIES,
      baseline: { commit: 'abc', tiers: [{ tier: 'T2', rate: 0.91 }] },
    });
    expect(r.verdict).toBe('PASS');
  });

  it('lets a definite failure outrank an inconclusive tier', () => {
    const r = evaluateGate({ results: full([F], [P, 'SKIPPED_CAP'], [P]), policies: POLICIES });
    expect(r.verdict).toBe('FAIL');
  });

  it('reports a per-tier breakdown', () => {
    const r = evaluateGate({ results: full([P, F], [P], [P]), policies: POLICIES });
    const t1 = r.tiers.find((t) => t.tier === 'T1');
    expect(t1?.passed).toBe(1);
    expect(t1?.failed).toBe(1);
    expect(t1?.rate).toBe(0.5);
  });
});
