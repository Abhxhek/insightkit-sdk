# Insightics

Prompt-driven, real-time analytics you can embed in a Node application in an afternoon.

Point it at your Postgres database, drop a component into your admin panel, and your users ask questions in plain language — *"how many users joined this week, split by signup method"* — and get a live chart back. No API to write, no dashboard to wire up, no component to design.

> **Status: published as 1.0.1, and still unproven against a real database.**
>
> It is on npm and the suite is green. But **nothing in this project has ever run against a real Postgres or a real model.** Every test uses a recording fake. The evaluation corpus exists and has scored exactly zero cases, because scoring requires executing queries against real data.
>
> So the engineering is production-shaped and the central product claim — that it answers *correctly* — is unmeasured. We would rather say that than let a test count imply otherwise.

## The constraint everything is built around

**SQL derived from a user prompt can only read. There is no exception.**

Insightics runs inside your production database. A write that escapes would be data loss in a system we do not own and cannot restore. So the read-only guarantee is not a setting, a policy or a code review convention — it is a stack of independent mechanisms, none of which is load-bearing alone:

| Layer | Enforces |
|---|---|
| `sql-guard` | one statement, must be `SELECT`, allowlisted node types, fields and functions |
| Deparse round-trip | what executes is re-emitted from the validated tree, never the input string |
| Row cap | clamped into the validated tree, then read back out of the emitted SQL |
| `ik_reader` role | `GRANT SELECT` only — there is no write privilege to escalate to |
| Sealed read-only transaction | `BEGIN READ ONLY`, `SET LOCAL` only, server-confirmed, always rolled back |
| Row-level security | tenant scoping enforced by Postgres on every access path, including subqueries |

`ik doctor` verifies the database-side guarantees against the live catalog rather than asking you to trust them, and exits non-zero when the proof fails — so it belongs in CI.

A second guarantee runs beside the first: Insightics' own metadata writes use a **different role**, touch only the `insightics` schema, and never carry user-authored SQL. That one is enforced in code — the store accepts only an admin connection and no SQL string — and is not yet checked by `ik doctor`.

## How a question becomes a chart

```
"how many users signed up this week, by signup method"
  │
  ├─ retrieval    pick up to 12 tables out of hundreds         pure, deterministic
  ├─ glossary     map "MRR" to mrr_cents                       pure
  ├─ prompt       render those tables as Postgres DDL          pure
  ├─ model        Anthropic or OpenAI → { sql, chart }         untrusted output
  ├─ guard        parse, allowlist, re-emit from the AST       ← the trust boundary
  ├─ repair       one retry if denied for an honest mistake
  ├─ scope        verified JWT → SET LOCAL app.tenant_id
  ├─ execute      BEGIN READ ONLY … always ROLLBACK
  ├─ wire         narrowed: no deny codes, no token counts
  └─ chart        hand-rolled SVG
```

## Quick start

```bash
npm install insightics-sdk pg @anthropic-ai/sdk
```

`insightics-sdk` is one install with an import path per part — `insightics-sdk/server`, `insightics-sdk/react`, `insightics-sdk/core` and so on — and deliberately no root import, so browser code cannot pull in server code by accident. Inside the repository the parts stay separate packages, which is where their boundaries are enforced; the build packs them into this one.

Server — one handler, mounted wherever you like:

```ts
import { asReaderSource, introspectSchema } from 'insightics-sdk/core';
import { fromPgPool } from 'insightics-sdk/core/pg';
import { anthropicProvider } from 'insightics-sdk/llm/anthropic';
import { createInsightics, SINGLE_TENANT_ACKNOWLEDGEMENT, singleTenant, toNextRoute } from 'insightics-sdk/server';
import { createGuard } from 'insightics-sdk/sql-guard';
import { Pool } from 'pg';

const source = asReaderSource(
  fromPgPool(new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 })),
);

const ik = createInsightics({
  source,
  guard: await createGuard({ maxRows: 1000 }),
  provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-opus-5' }),
  schema: () => introspectSchema(source, { excludeSchemas: ['insightics'] }),
  tenancy: singleTenant(SINGLE_TENANT_ACKNOWLEDGEMENT),
  live: {},
});

export const { GET, POST } = toNextRoute(ik.handler);
```

Browser — one component:

```tsx
'use client';
import { Insight } from 'insightics-sdk/react';

<Insight endpoint="/api/insightics" question="how many users signed up this week, by signup method" live />
```

`tenancy` is required and has no default. The single-tenant option demands that exact sentence rather than a boolean, because a boolean reads as a shrug in review and *"every user of this app may read every row"* reads as what it means. For multi-tenant, `multiTenantFromJwt()` verifies a bearer token and carries the tenant into the transaction, where Postgres row-level security enforces it.

`live` has to be on at both ends. Without `live` in the server config, no stream is issued and the component renders the answer once, without complaint. In multi-tenant mode a live feed also needs `tokenFrom` on the server, because a browser `EventSource` cannot send an `Authorization` header — see [`packages/server`](./packages/server).

## The security kernel

The component that decides whether SQL is safe is a package that **cannot execute SQL, cannot open a socket, and cannot read the filesystem**. It takes a string and returns a verdict. Something else runs the query.

```ts
import { createGuard } from 'insightics-sdk/sql-guard';

const guard = await createGuard({ allowedSchemas: ['public'] });

guard('SELECT count(*) FROM users');
// { ok: true, sql: 'SELECT count(*)\nFROM users', tables: [{ schema: null, name: 'users' }], rowLimit: null }

guard('SELECT 1; DROP TABLE users');
// { ok: false, code: 'E_MULTI_STATEMENT', detail: '2 statements; exactly 1 permitted' }

guard('SELECT * INTO exfil FROM users');
// { ok: false, code: 'E_FIELD_NOT_ALLOWED', detail: 'field not allowed on SelectStmt: intoClause' }

guard("SELECT pg_read_file('/etc/passwd')");
// { ok: false, code: 'E_FUNCTION_NOT_ALLOWED', detail: 'function not on allowlist: pg_read_file' }
```

Four properties worth knowing:

- **It never throws.** An exception is a bypass waiting for somebody's `try/catch`. Every failure is a verdict.
- **`ok: false` has no `.sql`.** The discriminated union makes the compiler reject code that skips the check.
- **The returned SQL is re-emitted from the validated tree**, not your input. Whatever obfuscation was in the original cannot survive, because it was never in the AST.
- **Its entire transitive dependency tree is five packages**, all of them parts of the Postgres parser. Auditable in a minute.

Validation uses `libpg_query` — Postgres's own parser, compiled to WebAssembly. When it says a statement is a `SELECT`, that is the same judgement the database will make.

## Architecture

The trust boundary is a package boundary, enforced in CI rather than by review.

```
packages/
  sql-guard/    security kernel - pure, zero I/O
  protocol/     the wire contract (browser <-> server), zod only
  core/         engine - reader path, introspection, planner, identity, semantic layer, store
  llm/          model provider adapters - Anthropic, OpenAI
  server/       HTTP + SSE handlers (next / node / fastify / hono)
  react/        components and hooks - browser only
  cli/          ik init | doctor | introspect
  insightics/   the one published package - the parts packed together, a subpath each, no root import
  eval/         release gate - corpus + scorer, never published
```

Three rules carry real weight, and `pnpm verify` fails on a breach of any of them — through the typecheck when the dependency is undeclared, and through `dependency-cruiser` when it is declared or reached by a relative path:

- **`react` may never import `core`** — one such import in a Next.js client component ships your connection string into the browser bundle.
- **`llm` may never import `sql-guard`** — the code talking to an untrusted model does not sit beside the code deciding what is trusted.
- **`core` may never import `llm`** — it declares the model provider shape structurally, exactly as it declares the database client, so reaching a model costs no dependency.

Each package has its own README with its boundary, usage and limits.

## Development

```bash
pnpm install
pnpm verify     # build + typecheck + lint + dependency rules + tests. The gate.
```

`pnpm verify` runs the full adversarial corpus, which must pass at 100%.

The evaluation corpus lives in [`packages/eval`](./packages/eval) — a reference schema, a golden question set, and the scorer. It deliberately contains adversarial cases the product does **not** yet block; each names the component that will block it, and asserts the gap is still open so it cannot be closed silently.

Once you have a Postgres, `pnpm --filter insightics-core smoke` turns the outstanding claims into observations — starting with whether `BEGIN READ ONLY` actually refuses a write.

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — the constraints, the package boundaries, and the rules that are not negotiable
- [docs/learn](./docs/learn) — eleven chapters on how this works and why it is shaped this way, written alongside the code
- [docs/adr](./docs/adr) — sixteen decisions that had a real alternative, and the reasoning
- [SECURITY.md](./SECURITY.md) — reporting, scope, and what counts as a vulnerability

## Contributing

Changes under `packages/sql-guard/` alter the read-only guarantee and get reviewed as such.

New attack cases in [`packages/sql-guard/test/corpus/attacks.json`](./packages/sql-guard/test/corpus/attacks.json) are the single most valuable contribution — a case that currently *passes* the guard is a bug report we would very much like to receive.

## Licence

Apache-2.0.
