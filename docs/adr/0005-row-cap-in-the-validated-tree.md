# ADR 0005 — The row cap is applied to the validated tree, not around it

Status: accepted, 2026-09-04

## Context

The plan describes the row cap as wrapping the query: `SELECT * FROM (<validated sql>) AS _guarded LIMIT <maxRows>`. Its own adjacent code deparses the unmodified tree, so the wrap never happens, and a summary table calls the result "AST-enforced". Nothing enforced it. `T4-S03` in the eval corpus existed precisely to record that gap.

## Decision

Clamp `SelectStmt.limitCount` **inside the tree the guard just validated**, before deparse. What executes is therefore SQL re-emitted from a tree that provably contains the limit, which is the same guarantee the rest of the guard rests on. Wrapping would mean concatenating strings around validated SQL — a new construction step outside that guarantee.

Clamping also preserves meaning. `SELECT … ORDER BY x DESC LIMIT 20` stays a top-20 query. Wrapping it as `SELECT * FROM (… ORDER BY x DESC) LIMIT 1000` relies on the planner preserving an inner `ORDER BY`, which SQL does not require.

After deparse, the emitted SQL is re-parsed and its limit is **read back out** and compared against the cap. The rewrite is not trusted; it is checked. That step exists because the failure this ADR is fixing was prose describing behaviour the code did not implement.

## What the parser made us handle

Verified by running it, not by reading about it:

| Input | Encoding | Why it matters |
|---|---|---|
| `LIMIT 0` | `{"ival":{}}` | libpg_query omits protobuf defaults, so zero is an **empty object**. Reading `ival.ival ?? cap` would raise `LIMIT 0` to the cap. |
| `LIMIT ALL` | `A_Const` with `isnull` | Present but means unlimited, so it must be treated as absent. |
| `LIMIT 2147483648` | `fval`, a string | Beyond int32, so it is not an `ival` at all. |
| `FETCH FIRST n ROWS WITH TIES` | `LIMIT_OPTION_WITH_TIES` | **Can return more rows than `n`.** A cap cannot be enforced, so it is denied. |
| `LIMIT $1` | `ParamRef` | Not comparable against the cap at validation time, so it is denied. |

## Consequences

- Two new deny codes, `E_LIMIT_NOT_ENFORCEABLE` and `E_LIMIT_NOT_STATIC`, both reachable only when a `maxRows` policy is set. Without a cap the guard's behaviour is unchanged.
- The allow verdict carries `rowLimit`, so a caller can tell the user their result was truncated.
- **This closes one hazard and no others.** A cap bounds rows returned, not work performed: a cross join still executes, which is `cost-ceiling` (`T4-S04`). It does not restrict which columns come back, which is `column-policy` (`T4-S01`). `T4-S03` moved from `unhandled` to `neutralised`, and the corpus now asserts the limit appears in the emitted SQL rather than merely in the verdict.
