# insightics

Prompt-driven, real-time analytics for a Node application. Point it at your Postgres database, drop a component into your admin panel, and your users ask questions in plain language — *"how many users joined this week, split by signup method"* — and get a live chart back.

SQL derived from a prompt can only ever read. That is enforced by a parser-based allowlist, a `GRANT SELECT`-only role, and a read-only transaction that always rolls back — not by asking a model nicely.

> **1.0.1, and still unproven against a real database.** Nothing in this project has run against a real Postgres or a real model yet; every test uses a recording fake. Run `ik doctor` against your own database before trusting it.

## Install

```bash
npm install insightics pg @anthropic-ai/sdk
```

Use `openai` instead of `@anthropic-ai/sdk` if that is your provider. `pg`, the model SDKs and `react` are optional peers: install the ones you use.

## One install, one import path per part

| Import | What it is | Runs in |
|---|---|---|
| `insightics/server` | the HTTP handler, with adapters for Next, Node/Express, Fastify and Hono | your server |
| `insightics/react` | `<Insight />`, `useAsk`, `useLiveResult` and dependency-free SVG charts | the browser |
| `insightics/core` | the read-only path, schema introspection, the planner, tenant scoping | your server |
| `insightics/core/pg` | the node-postgres adapter | your server |
| `insightics/sql-guard` | the security kernel: is this SQL a single, safe, read-only `SELECT`? | anywhere |
| `insightics/llm/anthropic`, `insightics/llm/openai` | model provider adapters | your server |
| `insightics/llm`, `insightics/protocol` | shared types and the browser–server contract | both |

It also installs the `ik` command: `npx ik init`, `npx ik doctor`, `npx ik introspect`.

**There is no `import … from 'insightics'`, on purpose.** A root import would mix browser and server code, and one wrong import in a client component would ship your database URL and model key into the browser bundle. Inside the repository each path is a separate package with its own enforced boundaries; the build packs them into this one, and a test checks that the packed `insightics/react` reaches nothing on the server side.

## Quick start

Server, mounted at `app/api/insightics/[...route]/route.ts`:

```ts
import { asReaderSource, introspectSchema } from 'insightics/core';
import { fromPgPool } from 'insightics/core/pg';
import { anthropicProvider } from 'insightics/llm/anthropic';
import { createInsightics, SINGLE_TENANT_ACKNOWLEDGEMENT, singleTenant, toNextRoute } from 'insightics/server';
import { createGuard } from 'insightics/sql-guard';
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

Browser:

```tsx
'use client';
import { Insight } from 'insightics/react';

export const Signups = () => (
  <Insight endpoint="/api/insightics" question="how many users signed up this week, by signup method" live />
);
```

`tenancy` is required and has no default. For multiple tenants, `multiTenantFromJwt()` verifies a bearer token and Postgres row-level security does the scoping.

## Before it touches production

Create the read-only roles, then prove from the live catalog that the reader cannot write:

```bash
npx ik init --database app --owner app_owner > provision.sql   # review it, then run it as an admin
DATABASE_URL=postgres://admin@host:5432/app npx ik doctor
```

`ik doctor` exits non-zero when the proof fails, so it belongs in CI. With multiple tenants, run it with `--strict`, or a table without row-level security passes as a review finding.

## Read more

How the read-only guarantee is built, how tenancy works, and exactly what has and has not been verified: [github.com/Abhxhek/insightkit-sdk](https://github.com/Abhxhek/insightkit-sdk).

Apache-2.0.
