# @insightkit/eval

The release gate: a reference schema, a golden question set, an adversarial corpus, and the scorer that turns a run over them into a verdict. **Never published.**

## The boundary

`@insightkit/sql-guard` is the only workspace package `eval` depends on; everything else it scores, it scores through a public API the caller injects. Three rules keep the gate honest about what it is measuring, each confirmed to fire by writing the offending import into a scratch tree and cruising it:

- `nothing-ships-the-harness` — no package may import `packages/eval/`. A gate is not a dependency. If a published package could reach the harness, the thing measuring the release would be part of the release.
- `eval-src-is-pure` — no Node builtin in `src`. The clock and all I/O are injected, so scoring re-runs from a results file without re-spending tokens. The corpus is read with `node:fs` in `test/`, which the rule deliberately leaves alone — the same import is an error one directory up and clean here.
- `eval-measures-the-shipped-system` — no `pg` in `src` **or** `test`. A direct driver import would let a reference query run on a path production never uses, and the gate would then be green about a different system.

`package.json` is `"private": true` as well, so a stray `pnpm publish` cannot ship it either.

## Install

You do not. `@insightkit/eval` is private and nothing may depend on it. It runs from inside the repo:

```sh
pnpm --filter @insightkit/eval test
```

## Usage

`src` has no I/O, so `run` and `sleep` are yours. `run` is where a case actually reaches a model and a database.

```ts
import { evaluateGate, resultSetsEqual, runCorpus } from '@insightkit/eval';

const run = await runCorpus(cases, { run: executeCase, sleep }, { concurrency: 5, spendCapUsd: 20 });

const report = evaluateGate({
  results: run.results,
  policies: [
    { tier: 'T1', floor: 0.95, zeroTolerance: false },
    { tier: 'T4', floor: 1, zeroTolerance: true },
  ],
  spendCapExceeded: run.spendCapExceeded,
});
// report.verdict is 'PASS' | 'FAIL' | 'INCONCLUSIVE'
```

The floors are the caller's: `TierPolicy` is an input, not a constant this package holds. `resultSetsEqual(actual, expected, { orderSensitive })` is the comparator `executeCase` would use to decide `PASS` or `FAIL`.

## What defines it

**Known gaps are asserted still open, so closing one turns the build red.** From [ADR 0003 — The adversarial gate measures two surfaces, not one](../../docs/adr/0003-two-adversarial-surfaces.md). `test/corpus.test.ts` runs every `expect: 'unhandled'` case through the real guard and asserts it is still *allowed*. Today that is `T4-S01` (`handledBy: column-policy`), `T4-S02` (`tenant-scoping`), `T4-S04` (`cost-ceiling`), and `T4-S05`/`T4-S06` (`planner-hardening`). The day a component blocks one of them, the test fails with a message telling you to reclassify it — a gap cannot be quietly closed or quietly forgotten. `T4-S03` has already been through that door: it is now `neutralised` by `row-cap`, and its assertion is that `LIMIT 1000` appears in the *emitted SQL* and not merely in the verdict.

**Two surfaces, not one.** `surface: 'guard'` is hostile SQL text hitting the validator — 9 cases, each asserting a specific deny code, deterministic, free, every commit. `surface: 'system'` is a prompt travelling the whole path — 6 cases, non-deterministic, costed, gated separately, because that is a different claim about a different mechanism. Gating all fifteen on one number invites weakening the system cases until the guard appears to handle hazards it has no vocabulary for: which columns may be read, which rows this viewer may see, and what a query costs to run.

**Grade by execution, as a quantised multiset.** [ADR 0004 — Compare result sets as a quantised multiset](../../docs/adr/0004-result-comparison.md). Set equality collapses duplicates, so a missing `DISTINCT` would pass; `resultSetsEqual` counts them. Numbers go through `toPrecision(6)` so equality is transitive and the rows can be sorted rather than matched pairwise; numeric *strings* are quantised too, because `count(*)` arrives as a string and `int4` as a number. Each cell is length-prefixed before joining, so no arrangement of cell contents can forge another row's key. The boundary artefact — two values straddling a rounding boundary — fails **closed**, as a spurious FAIL a human inspects.

**The gate cannot be made green by making it smaller.** `test/corpus.test.ts` asserts minimum tier sizes (T1 ≥ 8, T2 ≥ 12, T3 ≥ 5, guard surface ≥ 9) and that the reference schema still has its 8 tables. The corpus currently holds 25 golden and 15 adversarial cases. On the scoring side, `INFRA_ERROR` is excluded from the pass-rate denominator and capped at 3%, past which the tier is `INCONCLUSIVE` rather than scored; a spend cap marks the rest `SKIPPED_CAP`, which is also `INCONCLUSIVE`. Neither can become a `PASS`.

## What it does not do

- **It has never scored a single case.** There is no database to execute a reference query against and no model has been run through it. What runs today is corpus integrity, every reference query against the real guard, the deparse round-trip, and unit tests of the comparator, the runner and the gate — not one of which reaches a database or a model.
- **It does not execute SQL,** and cannot: `pg` is forbidden in `src` and `test` alike. Executing is `run`'s job, and `run` belongs to whoever is running the gate.
- **It does not price anything.** `costUsd` is whatever `run` reports. The spend cap meters that number; nothing validates it against a provider's bill.
- **The spend cap can overshoot.** It is checked after a case returns, so up to `concurrency` cases may already be in flight. Bounded concurrency is what makes the cap able to fire at all — `Promise.all` over the corpus would dispatch everything before the first cost came back.
- **Retries are transient-only.** `isTransientByMessage` matches timeouts, connection resets, 429/5xx and rate limits. A wrong answer is never retried into a pass.
- **`astEquivalent` is a deparse check, not a semantic one.** It drops known positional fields and reports any unrecognised position-shaped key rather than ignoring it, which is a prompt to review before widening the allowlist — not a proof that two different trees mean the same thing.
