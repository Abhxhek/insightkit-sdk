# @insightkit/core

The engine. Core is where "user SQL can only read" stops being a claim about a string and becomes a claim about a database: role split, sealed read-only transaction, isolation proofs, schema introspection, the planner, tenant scoping, and the approved-query store.

## The boundary

Core is the only package allowed to reach a database driver — `core-is-the-only-database-package` in [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs) forbids `pg` to every other package's `src`, so there is exactly one place where the sealed transaction can be enforced.

It is also fenced in from both sides:

- **`core-never-reaches-the-browser`** — core may not import `@insightkit/react` or `@insightkit/llm`. It holds connection material, and it declares the model provider *structurally* (`ModelProvider` in [`src/plan/provider.ts`](./src/plan/provider.ts)), exactly as it declares `SqlClient` rather than importing `pg`. Reaching a model therefore costs no dependency, and any client satisfying the shape works.
- **`browser-never-imports-engine`** — nothing in `@insightkit/react` may import core. One such import in a Next.js client component ships the connection string into the browser bundle.
- **`identity-is-not-the-guard`** — `src/identity/` may not import `src/plan/` or `@insightkit/sql-guard`. Deciding *who is asking* must not also be able to decide what SQL is safe.

`pnpm --filter @insightkit/core list --prod --depth Infinity` reports **9 packages**: `@insightkit/sql-guard` with its parser tree, plus `jose` for JWT verification.

## Install

```bash
pnpm add @insightkit/core

# only if you want the node-postgres adapter
pnpm add pg
```

`pg` is an **optional** peer dependency (`^8.11.0`) and lives behind the `@insightkit/core/pg` subpath, so the main entry point never references a driver and core stays testable without one.

## Usage

```ts
import { Pool } from 'pg';
import { createGuard } from '@insightkit/sql-guard';
import { approve, asReaderSource, runGuardedRead } from '@insightkit/core';
import { fromPgPool } from '@insightkit/core/pg';

// connectionTimeoutMillis is required — fromPgPool refuses a pool without one
const pool = new Pool({ connectionString: process.env.IK_READER_URL, connectionTimeoutMillis: 5_000 });
const reader = asReaderSource(fromPgPool(pool));

const guard = await createGuard({ allowedSchemas: ['public'], maxRows: 1000 });
const approval = approve(guard, 'SELECT provider, count(*) FROM logins GROUP BY provider');
if (!approval.ok) throw new Error(`${approval.code}: ${approval.detail}`);

const result = await runGuardedRead(reader, approval.query);
result.rows;         // { columns: [...], rows: [...] } — cells as the driver gave them
result.rowLimit;     // 1000, the cap the guard clamped into the tree
result.reachedLimit; // whether the result hit it
result.statements;   // every statement the transaction issued, in order
```

`result.statements`, recorded by running the above against a fake client:

```sql
BEGIN READ ONLY
SET LOCAL statement_timeout = '15000ms'
SET LOCAL lock_timeout = '2000ms'
SET LOCAL idle_in_transaction_session_timeout = '30000ms'
SET LOCAL row_security = on
SET LOCAL search_path = "pg_catalog", "public"
SHOW transaction_read_only
SELECT
  provider,
  count(*)
FROM logins
GROUP BY
  provider
LIMIT 1000
ROLLBACK
```

That `SELECT` is the guard's re-emitted SQL — reformatted, `LIMIT 1000` clamped in — not the string handed to `approve()`. Hand `runGuardedRead` a plain object instead of an `approve()` result and it refuses at runtime: `TypeError: runGuardedRead requires a query produced by approve; it was handed a plain object`.

## The subsystems

| Area | Files | What it owns |
|---|---|---|
| Reader path | `source.ts`, `approve.ts`, `execute.ts`, `session.ts` | capability-typed sources, the guarded-query brand, the sealed transaction |
| Driver adapter | `pg.ts` (`@insightkit/core/pg`) | `fromPgPool`, `FIDELITY_TYPES`, array row mode |
| Provisioning | `provision.ts` | 27 scoped + 5 cluster-wide DDL statements for the reader/login/metadata roles |
| Doctor | `doctor/` | 12 isolation checks: A0–A4 on reader privilege (blocking), T1–T4 on row security, B1–B3 on escalation surfaces |
| Introspection | `introspect/` | privilege-filtered catalog queries, capped at 200 tables / 5000 columns |
| Retrieval & planner | `plan/` | DDL rendering, lexical table selection, prompt, repair loop, `planQuery` |
| Identity | `identity/` | JWT verification, claims to `SET LOCAL app.tenant_id` |
| Semantic layer | `semantic/` | glossary definition, validation, question expansion |
| Query store | `store/` | cache key, migrations, `createQueryStore` |

## What defines it

**Reaching the database is a capability, not a convention.** `asReaderSource` wraps a pool and exposes only `connect()` — there is no `query()` to bypass the sealed transaction with — and `ReaderSource` and `AdminSource` are distinct branded types. `approve()` is the only producer of a `GuardedQuery`, and the brand is a real runtime symbol, so a cast compiles and then fails. See [ADR 0006 — Reaching the database is a capability, not a convention](../../docs/adr/0006-reader-path-is-a-capability.md).

**The transaction is sealed and never commits.** `BEGIN READ ONLY`, `SET LOCAL` for every setting (a plain `SET` leaks onto the next borrower of a pooled connection), `SHOW transaction_read_only` so the *server* confirms it, and an unconditional `ROLLBACK`. `pg_temp` is off the default search path because a writable temp schema there is the CVE-2018-1058 shadowing vector. `SET LOCAL` cannot take bind parameters, so identifiers are pattern-checked and timeouts range-checked, and both throw rather than escape.

**Values a driver cannot convert losslessly cross as text.** In a UTC+5:30 timezone, `pg`'s own parser turns the `date` `2026-09-05` into `2026-09-04T18:30:00.000Z` — a chart axis wrong by a day, silently, depending on the server's timezone. `FIDELITY_TYPES` returns `date`, `time`, `timestamp`, `interval`, `bytea`, `numeric[]` and the float types as the text Postgres sent, and it is a per-query registry because `pg.types.setTypeParser` is global and would change the host's own queries. See [ADR 0007](../../docs/adr/0007-driver-values-cross-the-boundary-as-text.md).

**Introspection describes what the reader can see, not what the database contains.** Every catalog query filters on `has_schema_privilege` / `has_table_privilege` / `has_column_privilege`, both ends of a foreign key are checked, and the metadata schema is excluded — naming a withheld table in a prompt is a disclosure even when no row leaks. Each query selects one row past its cap so truncation is observed rather than inferred. See [ADR 0008](../../docs/adr/0008-introspect-through-the-readers-eyes.md).

**Retrieval is lexical and says when it missed.** The schema goes into the prompt as Postgres DDL with comments and row estimates intact; tables are scored by token overlap and a match pulls in its foreign-key neighbours so a join stays expressible; the budget is checked by rendering the candidate set, not by estimating. `matched: false` is reported rather than a fallback being passed off as a hit. See [ADR 0009](../../docs/adr/0009-lexical-retrieval-before-embeddings.md).

**The planner repairs honest mistakes and never attacks.** A guard denial goes back to the model only when it looks like a mistake; `E_NOT_SELECT`, `E_MULTI_STATEMENT` and `E_NUL_BYTE` stop immediately and raise `onSecurityEvent` instead — not for safety, since every attempt ends at the guard anyway, but because repairing an attack hands the attacker an automated loop against the validator on the host's token budget. Two attempts by default; a repair turn carries our verdict, never the user's text. See [ADR 0011](../../docs/adr/0011-repair-honest-mistakes-never-attacks.md).

**Tenant isolation is Postgres's job.** Core does not rewrite SQL for tenancy — a predicate would have to hold on every relation reference including subqueries, CTEs and UNION arms, and missing one is silent cross-tenant disclosure. A verified JWT becomes `SET LOCAL app.tenant_id` and RLS enforces it. A session setting name must be `prefix.name`: without the mandatory dot a scope setting could target `row_security` or `search_path` and undo the preamble it travels with. See [ADR 0013](../../docs/adr/0013-tenant-isolation-is-postgres-job.md).

**A glossary is a disclosure surface, not a trust boundary.** A host-supplied SQL fragment is never parsed or executed — the model reads it, the guard validates what comes back — but it can name a column introspection deliberately withheld. Containment is proved by composition: refs ⊆ schema and fragment ⊆ refs, so no expression parser is needed. See [ADR 0014](../../docs/adr/0014-a-glossary-is-a-disclosure-surface.md).

## What it does not do

- **It has never run against a real Postgres.** Its tests (`npx vitest run packages/core` from the repo root) exercise pure functions and a recording fake client, and the `pg` adapter is driven through node-postgres' own type parsers. That proves what we send, what we refuse and how the driver converts — not how a server responds. [`scripts/smoke-pg.mjs`](./scripts/smoke-pg.mjs) turns the outstanding claims into observations: `DATABASE_URL=… pnpm --filter @insightkit/core smoke`.
- **The planner has never run against a real model.** Accuracy is unmeasured. `planQuery` takes a `ModelProvider` you supply.
- **`runGuardedRead` does not require a scope.** It accepts one through `options.scope`, but a host calling core directly can omit it and read unscoped. `@insightkit/server` closes that for its own callers; see [ADR 0015](../../docs/adr/0015-an-unscoped-read-must-be-impossible-by-accident.md) for what "impossible by accident" actually took.
- **It does not define the wire format.** Core has no dependency on `@insightkit/protocol` and declares its own `ChartSpec` and `ResultSet`; narrowing them for a browser is `@insightkit/server`'s job, deliberately.
- **It does not provision anything.** `provisioningScript()` returns strings for a human or the CLI to run. Core never executes DDL on your behalf, and migrations run only when invoked — creating a schema inside someone's production database at startup is a change their change log cannot explain.
- **It is not an HTTP server, a connection pool or a scheduler.** You bring the pool; core only ever calls `connect()` on it.
