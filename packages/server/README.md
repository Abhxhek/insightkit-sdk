# insightics-server

The HTTP surface. A web-standard `(Request) => Promise<Response>` that turns a question into a guarded, tenant-scoped read, plus an SSE endpoint that re-runs the approved query on a timer.

## The boundary

`server` imports `insightics-core` and `insightics-protocol`. That is the whole dependency list in `package.json`.

It never imports `insightics-sql-guard`: the guard's type is taken off core's own dependency shape (`export type Guard = PlanDeps['guard']` in `src/types.ts`), so a host passes a guard in and the package stays one step away from the thing that decides what is safe. It never imports a driver either — `core-is-the-only-database-package` in [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs) forbids `pg` from every `src` outside `core`, so the sealed read-only transaction has exactly one home.

How that is enforced, precisely:

- **`server-never-reaches-the-browser`** and **`server-reaches-the-guard-through-core`** forbid `react` and `sql-guard`. Both were confirmed to fire by importing each package into a scratch file — through a relative path, and through a simulated declared dependency.
- **An undeclared import never reaches those rules.** pnpm's strict layout leaves `insightics-react` unresolvable from this package, so dependency-cruiser reports it as unresolved rather than as a violation. The typecheck is what fails, with `TS2307: Cannot find module`. Either way `pnpm verify` goes red.
- **The rule that matters most is a test.** `test/leak.test.ts` reads every `.ts` under `src/` and asserts the files containing `runGuardedRead(` are exactly `['scope.ts']`, so an unscoped read cannot be added anywhere else.

## Install

```sh
npm install insightics
```

Not published on its own: it ships inside `insightics` and is imported from `insightics/server`. It declares no peer dependencies of its own. You supply three things it does not create for you:

- a guard — `createGuard()` from `insightics/sql-guard`
- a `ModelProvider` — core declares the shape structurally, so anything matching it works; `anthropicProvider` from `insightics/llm/anthropic` is one
- a `ReaderSource` — `fromPgPool` from `insightics/core/pg`, which needs `pg` (an **optional** peer)

## Usage

```ts
import { asReaderSource, introspectSchema } from 'insightics/core';
import { fromPgPool } from 'insightics/core/pg';
import { anthropicProvider } from 'insightics/llm/anthropic';
import {
  createInsightics,
  SINGLE_TENANT_ACKNOWLEDGEMENT,
  singleTenant,
  toNextRoute,
} from 'insightics/server';
import { createGuard } from 'insightics/sql-guard';
import { Pool } from 'pg';

const source = asReaderSource(
  fromPgPool(new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 })),
);

const ik = createInsightics({
  source,
  guard: await createGuard({ allowedSchemas: ['public'], maxRows: 1000 }),
  provider: anthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.INSIGHTICS_MODEL ?? '',
  }),
  schema: () => introspectSchema(source),
  schemaTtlMs: 300_000,
  tenancy: singleTenant(SINGLE_TENANT_ACKNOWLEDGEMENT),
  live: {},
});

export const { GET, POST } = toNextRoute(ik.handler);
```

`fromPgPool` refuses a pool without `connectionTimeoutMillis`: without it an exhausted pool waits forever, and a slow query turns every later request into a hang instead of an error. `live` is off unless configured — `live: {}` takes the defaults (a 5 s floor, a 15 s default interval, streams closed after 30 minutes); leave it out and `subscribe` answers 503 while `ask` issues no stream token.

Mount that at `app/api/insightics/[...route]/route.ts`. `handler` routes on the **last path segment** — `ask` and `subscribe` — so it works under any base path. `toNodeHandler` (Express, Connect, bare `node:http`), `toFastifyHandler` and `toHonoHandler` are the other adapters. None of those frameworks is a dependency: each adapter declares only the shape it needs, down to `NodeRequestLike` being an async iterable of chunks because that is all reading a body takes.

For multiple tenants, swap the `tenancy` line for `multiTenant(resolver)` or:

```ts
tenancy: await multiTenantFromJwt({
  token: { key: { kind: 'jwks', url: 'https://issuer.example/.well-known/jwks.json' }, algorithms: ['RS256'] },
  scope: { tenantClaim: 'org_id' },
}),
```

## What defines it

**An unscoped read is unreachable by omission.** Four layers, from [ADR 0015 — An unscoped read must be impossible by accident](../../docs/adr/0015-an-unscoped-read-must-be-impossible-by-accident.md): `tenancy` is required with no default and `createInsightics` throws without it; the single-tenant arm takes the exact sentence `'every user of this app may read every row'`, re-checked at runtime in `unscopedReadScope` rather than trusted from config; `ReadScope` carries `Symbol.for('insightics.server.scope')`, so a cast fails `isReadScope` at runtime; and `runScopedRead` is the only caller of `runGuardedRead`, which `test/leak.test.ts` enforces by grep.

**Every planner outcome answers HTTP 200.** `ok`, `unanswerable`, `refused` and `error` all leave as 200. A 422 for refused or a 502 for a model failure would rebuild the oracle [ADR 0012 — The wire is a narrowing](../../docs/adr/0012-the-wire-is-a-narrowing.md) closed: the status line alone would tell an attacker their probe was classified. Non-200 is only about whether the *request* was admissible — 404 for a path segment that is neither route, 405, 415/413/400, 401/403, 429/503, and 500 when our own outgoing validation rejects the body we were about to send. `src/narrow.ts` strips deny codes, once any attempt was denied the model's prose is dropped for a generic sentence, and the approved SQL crosses only when the host sets `exposeSql` (off by default).

**Tenancy is a session setting, not a rewritten query.** A verified token becomes `SET LOCAL app.tenant_id = '…'` inside core's sealed transaction and RLS does the rest, per [ADR 0013 — Tenant isolation is Postgres's job](../../docs/adr/0013-tenant-isolation-is-postgres-job.md). The package never adds a predicate to anyone's SQL.

## What it does not do

- **Nothing here has run against a real Postgres, a real model or a real HTTP server.** Every test drives a recording fake client (`test/fake.ts`), a scripted provider and in-process `Request`/`Response` objects.
- **Limits are in memory and per process.** `createLimiter` is a token bucket in a `Map`; N instances means N times the limits. There is no distributed limiter, and the source says plainly that the numbers are a cost floor rather than a security control — the security control is the scope.
- **A web `Request` cannot see the peer address.** Before a token is verified there is nothing to bucket on, so an unauthenticated flood in multi-tenant mode is bounded only by the body cap and signature verification. In single-tenant mode every caller shares one bucket unless you pass `identify(request)` fed from a trusted proxy header.
- **The stream store is per process.** `createMemoryStreamStore` holds tokens in a `Map`. Behind a load balancer, supply a `StreamStore` — and it must keep the SQL and re-run `approve` on the way out rather than reviving a branded object.
- **A subscription's scope is resolved once, not per tick.** The tenant setting is re-applied on every read, but the token is verified only at subscribe time, so a token revoked mid-stream keeps streaming until `maxDurationMs` (default 30 minutes). Closing that properly needs `TenantScope` to carry the token's expiry, which it currently drops; see ADR 0015.
- **Live updates in multi-tenant mode need `tokenFrom`.** `subscribe` resolves the tenant from the same bearer token `ask` does, and a browser `EventSource` cannot set an `Authorization` header. With the defaults, `<Insight live />` therefore gets a 401 on the stream in multi-tenant mode and ends up showing "Lost the live feed." Point `tokenFrom` at somewhere an `EventSource` can carry the token — a same-origin cookie — or give the component an `eventSourceFactory` that can send headers.
- **No CORS, no CSRF, no session handling.** The bearer token is the whole auth story, and `checkGlossary()` is yours to call at boot and fail on.
