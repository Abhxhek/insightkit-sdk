export type Tier = 'T1' | 'T2' | 'T3' | 'T4';

export type AdversarialSurface = 'guard' | 'system';

export interface ResultSet {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

export interface CompareOptions {
  readonly orderSensitive: boolean;
  readonly significantDigits?: number;
  readonly numericStrings?: 'coerce' | 'strict';
}

export type CompareResult = { readonly equal: true } | { readonly equal: false; readonly reason: string };

export interface GoldenCase {
  readonly id: string;
  readonly tier: 'T1' | 'T2' | 'T3';
  readonly prompt: string;
  readonly sql: string | null;
  readonly chart: string;
  readonly orderSensitive: boolean;
  readonly tags: readonly string[];
  readonly tests: string;
}

export type AdversarialExpectation = 'blocked' | 'neutralised' | 'unhandled';

export interface AdversarialCase {
  readonly id: string;
  readonly surface: AdversarialSurface;
  readonly prompt: string;
  readonly sql: string | null;
  readonly expect: AdversarialExpectation;
  readonly expectCode: string | null;
  readonly handledBy: string | null;
  readonly why: string;
}

export type CaseStatus = 'PASS' | 'FAIL' | 'INFRA_ERROR' | 'SKIPPED_CAP';

export interface CaseResult {
  readonly id: string;
  readonly tier: Tier;
  readonly status: CaseStatus;
  readonly sql?: string;
  readonly costUsd?: number;
  readonly detail?: string;
}

export interface TierPolicy {
  readonly tier: Tier;
  readonly floor: number;
  readonly zeroTolerance: boolean;
}

export interface TierScore {
  readonly tier: Tier;
  readonly passed: number;
  readonly failed: number;
  readonly infra: number;
  readonly skipped: number;
  readonly rate: number | null;
  readonly verdict: GateVerdict;
  readonly reason: string;
}

export type GateVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface Baseline {
  readonly commit: string;
  readonly tiers: readonly { readonly tier: Tier; readonly rate: number }[];
}

export interface GateInput {
  readonly results: readonly CaseResult[];
  readonly policies: readonly TierPolicy[];
  readonly baseline?: Baseline;
  readonly maxInfraRate?: number;
  readonly regressionTolerance?: number;
  readonly spendCapExceeded?: boolean;
}

export interface GateReport {
  readonly verdict: GateVerdict;
  readonly tiers: readonly TierScore[];
  readonly reasons: readonly string[];
  readonly totalCostUsd: number;
}
