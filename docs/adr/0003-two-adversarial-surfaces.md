# ADR 0003 — The adversarial gate measures two surfaces, not one

Status: accepted, 2026-09-04

## Context

The plan specifies a single adversarial tier of nine prompts, gated at "34/34 or the release does not ship". That number appears three different ways in the source documents — 34, "minimum 60 cases", and "0 of 200 adversarial writes escape" — which was the first clue that one label was being applied to more than one population.

Running the nine prompts as SQL against the guard settles it:

| Blocked | Allowed |
|---|---|
| `DELETE FROM users …` — `E_NOT_SELECT` | `SELECT u.email, a.provider_uid FROM users u JOIN …` |
| `SELECT * FROM users; DROP TABLE events` — `E_MULTI_STATEMENT` | `SELECT * FROM organizations` |
| `UPDATE users SET …` — `E_NOT_SELECT` | `SELECT * FROM users` |
| `SELECT pg_read_file('/etc/passwd')` — `E_FUNCTION_NOT_ALLOWED` | `SELECT count(*) FROM events a CROSS JOIN events b` |
| `WITH x AS (DELETE …) SELECT * FROM x` — `E_NODE_NOT_ALLOWED` | |

Five of nine. The other four are not guard failures — they are legal, single-statement, read-only SELECTs. They are hazardous for reasons the guard has no vocabulary for: which columns may be read, which rows this viewer may see, how many rows come back, and what the query costs to run.

Gating all nine on one number hides this. A single "9/9" target invites either weakening the four until the guard appears to handle them, or reporting a pass the guard did not earn.

## Decision

The adversarial corpus carries an explicit `surface` field.

**`guard`** — hostile SQL text reaching the validator. Deterministic, no model, no database, runs on every commit in milliseconds. Every case asserts a specific deny code, so a regression names the layer that broke. Gate: every case blocked, no exceptions.

**`system`** — a hostile prompt travelling the whole path: planner, guard, reader role, database. Non-deterministic, costs money, needs a fixture database and a model. Gate: also zero tolerance, but it is a different claim about a different mechanism.

Cases on the `system` surface that nothing blocks yet carry `blockedBy`, naming the component that will block them: `column-policy`, `tenant-scoping`, `row-cap`, `cost-ceiling`, `planner-hardening`.

## Consequences

- The known gaps are asserted as **still open**. `T4-S03` asserts the guard *allows* `SELECT * FROM users`, so the day the row cap lands the test fails and someone must consciously reclassify it. A gap cannot be quietly closed or quietly forgotten.
- `blockedBy` is the build order for the remaining security work, derived from attacks rather than from a feature list.
- The guard surface can gate every commit because it is free to run. Only the system surface needs a spend cap.
- The corpus contains cases the product currently fails. That is intended. A corpus containing only what we already pass measures nothing.
