import type { CaseResult, GateInput, GateReport, GateVerdict, TierPolicy, TierScore } from './types.js';

const DEFAULT_MAX_INFRA_RATE = 0.03;
const DEFAULT_REGRESSION_TOLERANCE = 0.02;

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const scoreTier = (
  rows: readonly CaseResult[],
  policy: TierPolicy,
  priorRate: number | undefined,
  maxInfraRate: number,
  regressionTolerance: number,
): TierScore => {
  const passed = rows.filter((r) => r.status === 'PASS').length;
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  const infra = rows.filter((r) => r.status === 'INFRA_ERROR').length;
  const skipped = rows.filter((r) => r.status === 'SKIPPED_CAP').length;
  const scored = passed + failed;
  const rate = scored === 0 ? null : passed / scored;
  const base = { tier: policy.tier, passed, failed, infra, skipped, rate };

  if (rows.length === 0) {
    return { ...base, verdict: 'INCONCLUSIVE', reason: 'no cases ran for this tier' };
  }
  if (rate === null) {
    return {
      ...base,
      verdict: 'INCONCLUSIVE',
      reason: `no case produced a score (${infra} infra, ${skipped} skipped)`,
    };
  }
  if (infra / (scored + infra) > maxInfraRate) {
    return {
      ...base,
      verdict: 'INCONCLUSIVE',
      reason: `${infra}/${scored + infra} infrastructure errors exceeds ${pct(maxInfraRate)}`,
    };
  }
  if (skipped > 0) {
    return { ...base, verdict: 'INCONCLUSIVE', reason: `${skipped} case(s) skipped by the spend cap` };
  }
  if (policy.zeroTolerance && failed > 0) {
    return { ...base, verdict: 'FAIL', reason: `${failed} case(s) failed and this tier has zero tolerance` };
  }
  if (rate < policy.floor) {
    return { ...base, verdict: 'FAIL', reason: `${pct(rate)} is below the floor of ${pct(policy.floor)}` };
  }
  if (priorRate !== undefined && rate < priorRate - regressionTolerance) {
    return {
      ...base,
      verdict: 'FAIL',
      reason: `regression against baseline: ${pct(priorRate)} -> ${pct(rate)}, beyond the ${pct(regressionTolerance)} tolerance`,
    };
  }
  return { ...base, verdict: 'PASS', reason: `${pct(rate)} (floor ${pct(policy.floor)})` };
};

export function evaluateGate(input: GateInput): GateReport {
  const maxInfraRate = input.maxInfraRate ?? DEFAULT_MAX_INFRA_RATE;
  const regressionTolerance = input.regressionTolerance ?? DEFAULT_REGRESSION_TOLERANCE;
  const totalCostUsd = input.results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  const tiers = input.policies.map((policy) =>
    scoreTier(
      input.results.filter((r) => r.tier === policy.tier),
      policy,
      input.baseline?.tiers.find((t) => t.tier === policy.tier)?.rate,
      maxInfraRate,
      regressionTolerance,
    ),
  );

  const reasons = tiers.filter((t) => t.verdict !== 'PASS').map((t) => `${t.tier}: ${t.reason}`);
  if (input.spendCapExceeded === true) reasons.push('run aborted by the spend cap; results are partial');

  let verdict: GateVerdict = 'PASS';
  if (tiers.some((t) => t.verdict === 'FAIL')) verdict = 'FAIL';
  else if (tiers.some((t) => t.verdict === 'INCONCLUSIVE') || input.spendCapExceeded === true) {
    verdict = 'INCONCLUSIVE';
  }

  return { verdict, tiers, reasons, totalCostUsd };
}
