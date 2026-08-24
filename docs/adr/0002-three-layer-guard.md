# ADR 0002 — The guard needs three independent layers, not one

Status: accepted, 2026-08-25

## Context

Initial design assumed one check would do: walk the AST, allowlist node types, done. Empirical testing against the parser showed two separate ways that check can be complete and still wrong.

## Findings

**Untagged inlined structs.** libpg_query does not wrap struct-typed fields in a node tag. `withClause`, `alias`, `over` and `typeName` all appear as bare objects. So does `intoClause`. Consequently `SELECT * INTO exfil FROM users` — a statement that creates a table — produces only these tags:

    A_Star  ColumnRef  RangeVar  ResTarget  SelectStmt

Every one is legitimate. A tag-only allowlist permits it.

By contrast `SELECT ... FOR UPDATE` does surface a `LockingClause` tag and is caught. The hazards are not symmetric, so this cannot be reasoned about without measuring.

**Legal structure, hostile content.** `SELECT pg_read_file('/etc/passwd')` and `SELECT dblink(...)` use only tags that legitimate queries also use. The danger is the function name, which is data inside a `FuncCall` node, not structure.

## Decision

Four checks, each catching a class the others structurally cannot:

| Layer | Catches | Example it alone stops |
|---|---|---|
| Statement shape | wrong root, stacked statements | `SELECT 1; DROP TABLE users` |
| Node tag allowlist | writes anywhere in the tree | `WITH x AS (DELETE ...) SELECT * FROM x` |
| Field allowlist per tag | untagged inlined structs | `SELECT * INTO exfil FROM users` |
| Function name allowlist | legal structure, hostile call | `SELECT pg_read_file('/etc/passwd')` |

## Consequences

- The field allowlist must be maintained per node tag. It was derived empirically alongside the tag list.
- Removing any layer reopens a whole category. Each has a dedicated case in the attack corpus with the deny code asserted, so a regression names the layer that broke.
- Function allowlisting rejects user-defined functions outright. A customer wanting their own function in a query must have it added to policy explicitly; there is no way to infer that an arbitrary function is side-effect free.
