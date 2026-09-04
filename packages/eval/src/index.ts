export { resultSetsEqual } from './compare.js';
export type { FidelityResult } from './fidelity.js';
export { astEquivalent, POSITIONAL_FIELDS } from './fidelity.js';
export { evaluateGate } from './gate.js';
export type { CaseInput, CaseOutcome, CorpusRun, CorpusRunOptions, RunnerDeps } from './runner.js';
export { isTransientByMessage, runCase, runCorpus } from './runner.js';
export type {
  AdversarialCase,
  AdversarialSurface,
  Baseline,
  CaseResult,
  CaseStatus,
  CompareOptions,
  CompareResult,
  GateInput,
  GateReport,
  GateVerdict,
  GoldenCase,
  ResultSet,
  Tier,
  TierPolicy,
  TierScore,
} from './types.js';
