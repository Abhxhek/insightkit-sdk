# Architecture decision records

Decisions that had a real alternative, and the reasoning. A decision with only one plausible option is a convention, and lives in [ARCHITECTURE.md](../ARCHITECTURE.md) instead.

Each record states what was decided, what it costs, and what was rejected. The *rejected* section is usually the useful one.

## The guard

| | Decision | Status |
|---|---|---|
| 0001 | [Allowlist AST node types rather than denylist them](./0001-allowlist-over-denylist.md) | accepted 2026-08-25 |
| 0002 | [The guard needs independent layers, not one](./0002-three-layer-guard.md) | accepted 2026-08-25 |
| 0005 | [The row cap is applied to the validated tree, not around it](./0005-row-cap-in-the-validated-tree.md) | accepted 2026-09-04 |

## Measuring it

| | Decision | Status |
|---|---|---|
| 0003 | [The adversarial gate measures two surfaces, not one](./0003-two-adversarial-surfaces.md) | accepted 2026-09-04 |
| 0004 | [Compare result sets as a quantised multiset](./0004-result-comparison.md) | accepted 2026-09-04 |

## Reaching the database

| | Decision | Status |
|---|---|---|
| 0006 | [Reaching the database is a capability, not a convention](./0006-reader-path-is-a-capability.md) | accepted 2026-09-04 |
| 0007 | [Values that a driver cannot convert losslessly cross the boundary as text](./0007-driver-values-cross-the-boundary-as-text.md) | accepted 2026-09-05 |
| 0008 | [Introspection describes what the reader can see, not what the database contains](./0008-introspect-through-the-readers-eyes.md) | accepted 2026-09-05 |

## Asking the model

| | Decision | Status |
|---|---|---|
| 0009 | [Retrieval starts lexical, and the schema goes into the prompt as DDL](./0009-lexical-retrieval-before-embeddings.md) | accepted 2026-09-05 |
| 0010 | [The model is a dependency that lies, refuses, and stops halfway](./0010-the-model-is-an-untrusted-dependency.md) | accepted 2026-09-10 |
| 0011 | [Repair an honest mistake, never an attack](./0011-repair-honest-mistakes-never-attacks.md) | accepted 2026-09-10 |
| 0014 | [A glossary is a disclosure surface](./0014-a-glossary-is-a-disclosure-surface.md) | accepted 2026-09-27 |

## Leaving the server

| | Decision | Status |
|---|---|---|
| 0012 | [The wire is a narrowing, not a re-export](./0012-the-wire-is-a-narrowing.md) | accepted 2026-09-27 |
| 0013 | [Tenant isolation is Postgres's job, not ours](./0013-tenant-isolation-is-postgres-job.md) | accepted 2026-09-27 |
| 0015 | [An unscoped read must be impossible by accident](./0015-an-unscoped-read-must-be-impossible-by-accident.md) | accepted 2026-09-29 |
| 0016 | [Drawing numbers that arrive as text](./0016-drawing-numbers-that-arrive-as-text.md) | accepted 2026-09-29 |

---

New records are numbered sequentially and never renumbered; a superseded decision keeps its number and gains a status line pointing at its replacement.
