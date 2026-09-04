# ADR 0004 — Compare result sets as a quantised multiset

Status: accepted, 2026-09-04

## Context

Grading text-to-SQL by string comparison does not work: many correct queries are textually different from the reference. Grading has to be by execution — run both, compare the rows.

The reference implementation most projects borrow is BIRD's, `set(predicted) == set(ground_truth)` with a timeout. It has two defects that matter for a product gate:

**Set equality collapses duplicates.** A query missing a `DISTINCT` returns extra rows, the set comparison discards them, and the case passes. That is a real bug shipping as a green test.

**No float tolerance.** `1249.9999999998` fails against `1250.0`, and the morning goes on a non-bug.

There is also a type problem specific to Postgres: `count(*)` is `int8` and `sum(x) / 100.0` is `numeric`, and the `pg` driver returns both as **strings** to avoid precision loss, while `int4` comes back as a number. Both sides of a comparison can therefore disagree on type while agreeing on value.

## Decision

Compare as a **multiset**, positionally by column, with values normalised to a canonical string:

- `null` and `undefined` collapse to one sentinel; nothing else maps to it
- numbers are quantised with `toPrecision(6)`, which is the 1e-6 relative tolerance the plan asks for
- strings matching a strict numeric literal are quantised too, resolving the driver's type skew
- `Date` compares by instant, `jsonb` by key-sorted serialisation
- each cell is length-prefixed before joining, so no arrangement of cell contents can forge another row's key

Order sensitivity is **declared per question** rather than inferred by testing the reference SQL for `ORDER BY`. Whether order is part of the answer is a property of the question — a top-10 list versus a grouped total — not of how the reference query happened to be written.

## Alternatives considered

**Pairwise epsilon matching.** Compare each row against every unmatched candidate with a relative-error test. Exact, and it avoids the boundary artefact below, but epsilon equality is **not transitive**, so it cannot be implemented by sorting; it needs O(n²) greedy matching, and greedy matching can fail to find a valid pairing that exists.

Quantising makes equality transitive by construction, which is what allows the sort. The cost is a boundary artefact: two values that straddle a rounding boundary while differing by less than the tolerance are reported as different. This requires agreement to roughly 1e-6 *and* a straddle, and when it fires it fails **closed** — a spurious FAIL a human then inspects, never a spurious PASS. For a release gate that is the correct direction to be wrong in.

**Comparing by column name.** Rejected. It would fail a correct query for choosing `AS signup_count` over `AS signups`, which measures aliasing rather than correctness. Column naming is a presentation concern and belongs to the view spec.

## Consequences

- Duplicate rows are counted, so a missing `DISTINCT` fails as it should.
- `significantDigits` and `numericStrings` are per-comparison options; the defaults are the product's, not the comparator's.
- The failure message names the first unmatched row on both sides. A gate whose failures are hard to read gets muted.
