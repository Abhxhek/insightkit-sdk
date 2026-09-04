# ADR 0008 — Introspection describes what the reader can see, not what the database contains

Status: accepted, 2026-09-05

## Context

A planner cannot write SQL against a schema it has not been told about, so `core` now reads the catalog and returns a structured description of it. The obvious implementation reads `information_schema` as whichever role happens to be connected — in practice an administrator, because setup runs as one.

That produces a description of *the database*. What the product needs is a description of *what the reader role may select from*, and the two are not the same.

The difference matters twice.

**A wrong answer.** A table the model knows about but the reader cannot read yields SQL that fails at execution. The user sees an error for a question the product appeared to accept.

**A disclosure.** A customer who deliberately withheld `payroll` from the reader has made a security decision. If introspection describes it anyway, the table and its column names enter a prompt — and a prompt is sent to a third-party model, is logged, and can be quoted back in a response the end user reads. The row data never leaks, but the schema does, and a schema is not always uninteresting: `patients.hiv_status` discloses something merely by existing.

Three narrower cases sit inside the same problem:

- **Column grants are real.** A role can hold `SELECT` on `users` and not on `users.ssn`. Filtering at table granularity advertises a column that was explicitly withheld.
- **A foreign key names a second table.** A constraint on a visible table can point at a hidden one, so filtering only the near side discloses the far side's name through the relationship.
- **Our own metadata schema is in the same database.** The model has no business knowing InsightKit's tables exist.

## Decision

**Visibility is decided by Postgres, per object, and it is the reader's visibility.** Every catalog query is filtered by `has_schema_privilege`, `has_table_privilege` and `has_column_privilege`. With no role named these resolve against the connected role, which is correct when introspecting over the reader connection; `asRole` asks the question about a named role instead, for the case where setup runs as an administrator.

Both ends of a foreign key are filtered, so a constraint pointing at an unreadable table is omitted rather than disclosing it. `excludeSchemas` keeps the metadata schema out, matching what `doctor`'s A4 check already proves the reader cannot reach.

**Postgres answers the privilege question, not us.** `has_table_privilege` accounts for role inheritance, `GRANT`s to `PUBLIC`, column-level grants and ownership. Fetching everything and filtering in TypeScript would mean reimplementing that, and a privilege engine that is subtly wrong in the permissive direction is precisely the bug this decision exists to prevent.

**Keys come from `pg_constraint`, not `pg_index`.** `pg_constraint.conkey` is a genuine `int2[]`, so `unnest(...) WITH ORDINALITY` recovers the key columns in their defined order. `pg_index.indkey` is an `int2vector`, which needs a cast before it can be unnested and orders badly when done carelessly — and a composite key in the wrong order is a wrong join.

**Results are capped and truncation is reported.** `maxTables` and `maxColumns` bound what a several-thousand-table database can pull into memory. The queries select one row past the cap so truncation is observed rather than inferred, and `truncated` is part of the result: a partial schema presented as complete would let the planner conclude a table does not exist.

**The catalog SQL is validated by parsing it.** These queries cannot run in CI, since there is no database. They are parsed with `pgsql-parser` — the same libpg_query build the guard uses — so a syntax error in the lateral `unnest` joins fails a test rather than waiting for a first connection.

## Consequences

Introspection reports less than the database holds, by design, and `observedAs` records whose view it is so a confusing result can be diagnosed rather than guessed at.

If a customer grants the reader access to a new table, it appears only after the next introspection. Caching and invalidation are not addressed here.

`estimatedRows` comes from `reltuples`, which is an estimate and is `-1` on a relation that has never been analysed (clamped to `0`). It is only ever used to rank candidate tables during retrieval, never to answer a question.

A table whose columns were all cut by the column cap is still listed, with an empty column list. Keeping it is the honest reading — the table is visible — but a consumer must not treat "no columns" as "no readable columns".

## Alternatives rejected

**Read `information_schema`.** Its views already filter by the current user's privileges, which solves part of this. Rejected because it cannot answer the question about a *different* role, which is what setup-time introspection needs; it omits materialized views entirely; and it does not expose `relkind` or `reltuples`, both of which the planner and retrieval want.

**Introspect as an administrator and filter afterwards.** Simpler to write and gives a complete picture for debugging. Rejected because the filtering is the security property, and doing it ourselves means reimplementing Postgres' privilege resolution.

**Describe everything and rely on the reader role to refuse at execution.** The database would indeed refuse the query, so G1 holds. Rejected because the disclosure has already happened by then: the schema reached the prompt.
