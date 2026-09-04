# 06 — Telling a model what it may look at

A model cannot write SQL against a schema it has never seen. Before any planner exists, something has to read the customer's database and produce a description of it. That is what `introspectSchema` does, and the interesting part is not reading the catalog — it is deciding what to leave out.

## The description is not of the database

The instinct is to describe everything: every table, every column, all the relationships. That is what most schema-dump tools do, and it is what you would write first.

It is the wrong output, for two separate reasons.

The **boring** reason is correctness. Setup usually runs as an administrator, so an unfiltered dump describes tables the *reader* role cannot select from. The model writes a perfectly reasonable query against `payroll`, the database refuses it, and the user gets an error for a question the product appeared to accept.

The **interesting** reason is that a schema is information. A customer who withheld `payroll` from the reader made a security decision. If we describe it anyway, the table name and its columns go into a prompt — and a prompt travels to a third-party model, gets logged, and can be quoted back in an answer the end user reads. No row ever leaks. The schema does.

That is not always harmless. `patients.hiv_status` discloses something by existing. So does `acquisitions_2027`. The rule we settled on:

> The set of tables described must equal the set the reader can actually read.

## Letting Postgres answer

The filtering could be done in TypeScript: fetch everything, then work out what the reader may see. Don't. Postgres already has a function for this, and getting it right means modelling role inheritance, `GRANT`s to `PUBLIC`, column-level grants, ownership and default privileges.

A privilege engine of our own that is subtly wrong in the *permissive* direction is exactly the bug this whole feature exists to prevent. So every catalog query carries:

```sql
AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
AND pg_catalog.has_column_privilege(c.oid, a.attnum, 'SELECT')
```

With no role named, those resolve against whoever is connected — right when introspecting over the reader's own connection. Pass `asRole` and they answer about that role instead, for the setup-time case where we are connected as an admin but want the reader's view.

Note this is the mirror image of a trap in `doctor`. There, check A0 refuses to run the proof *as* the role under test, because privilege views under-report from the inside and under-reporting looks like passing. Here the risk runs the other way: introspect as an admin and you **over**-report. Same views, opposite failure, both fixed by being explicit about whose question you are asking.

## Three leaks that survive the obvious fix

Filtering tables is not enough.

**Columns have their own grants.** A role can hold `SELECT` on `users` but not on `users.ssn`. Filter only at table granularity and you advertise a column that was explicitly withheld — arguably worse than leaking a whole table, because someone took the trouble to withhold exactly that one.

**A foreign key names a second table.** A visible table can carry a constraint pointing at a hidden one. Filter only the near side and the relationship discloses the far side's name. So both ends are filtered:

```sql
WHERE con.contype = 'f'
  AND <near side visible>
  AND <far side visible>
```

**Our own tables are in the same database.** The `insightkit` metadata schema holds sessions and cached results. The model has no business knowing it exists, which is why `excludeSchemas` takes it — the same schema `doctor`'s A4 check separately proves the reader cannot reach.

## Two things Postgres makes easy to get wrong

**Composite keys come from `pg_constraint`, not `pg_index`.** Both can tell you the primary key. `pg_index.indkey` is an `int2vector` — a legacy type that needs a cast before `unnest` will take it, and that orders badly if you reach for `= ANY(indkey)`, which discards order entirely. `pg_constraint.conkey` is a real `int2[]`:

```sql
CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
```

`WITH ORDINALITY` is what preserves the order. A composite key in the wrong order is a wrong join, and it will look plausible.

**`reltuples` is an estimate, and sometimes a lie.** It is the planner's row-count guess, refreshed by `ANALYZE`, and on a table that has never been analysed it is `-1`, not `0`. We clamp it and use it only to *rank* candidate tables during retrieval. It must never reach an answer — "how many users do we have" gets a `count(*)`, not a statistic.

## Testing SQL you cannot run

There is still no Postgres on this machine, and these queries are the gnarliest SQL in the project — lateral joins, two-argument `unnest`, `WITH ORDINALITY`. A typo would sit undetected until the first real connection.

But we already ship a Postgres parser. `sql-guard` is built on `libpg_query`, the actual C parser from Postgres compiled to WASM. So the tests parse every generated query:

```ts
for (const sql of ALL()) expect(() => parseSync(sql)).not.toThrow();
```

This is worth being precise about, because it is easy to overclaim. Parsing proves the SQL is **syntactically valid Postgres**. It proves nothing about whether `conkey` is the right column, whether the join produces the rows we expect, or whether the privilege filter is correct. It catches one class of bug completely and no others — which is still much better than finding a missing comma in production, and it costs nothing.

A separate check confirms the test has teeth: feed the same assertion a query with a dangling `WHERE` and it must fail. A validity test that cannot fail is decoration.

## Bounded, and honest about it

A database with 4,000 tables would pull an enormous amount into memory and then into a prompt. So `maxTables` and `maxColumns` cap the result.

The detail that matters is how truncation is detected. Each query selects **one row past the cap**:

```sql
LIMIT ${maxTables + 1}
```

If that extra row comes back, there was more, and `truncated: true` goes into the result. The alternative — returning exactly the cap and inferring "probably more" — cannot distinguish a database with exactly 200 tables from one with 5,000. And a partial schema presented as complete is dangerous in a specific way: the planner concludes a table *does not exist* and answers the question from the wrong one.

## What went wrong writing this

Two bugs, both silent, both caught before they ran.

The first was a key collision. Columns are grouped by table with a composite key, and the first version joined the parts with a space:

```ts
const key = (...parts) => parts.map(text).join(' ')
```

Postgres identifiers can contain spaces. Schema `"a b"` table `"c"` and schema `"a"` table `"b c"` both produce `a b c`, and one table silently inherits the other's columns. The fix is length prefixing, so the encoding is injective:

```ts
`${s.length}:${s}`   // "3:a b1:c" vs "1:a3:b c"
```

The eval harness had already learned this lesson for row keys. It did not transfer until it broke again.

The second was writing the queries to run concurrently with `Promise.all`. They share one connection. `pg` happens to queue queries on a client so it would have worked — but it would have worked because of the driver's behaviour, not ours, and this is inside a transaction whose ordering is a security property. They run sequentially now.

---

Next: turning this description into something a model can be given, which is a different problem — a 200-table schema does not fit in a prompt, and choosing the ten tables that matter for one question is retrieval, not introspection.
