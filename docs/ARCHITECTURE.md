# InsightKit — architecture and constraints

This document is the compressed reference for how InsightKit is put together and which rules are not negotiable. It is aimed at anyone reading or contributing to the codebase.

InsightKit is an open-source TypeScript SDK that embeds prompt-driven, real-time analytics into an existing Node application. A developer points it at their Postgres database, drops a React component into their admin panel, and their users ask questions in natural language — "how many users joined this week, split by signup method" — and get a live chart back.

The product replaces the usual loop of: write an API, wire it to a dashboard, fetch, design a component, ship.

## The hard constraint

**User-originated SQL is SELECT-only. There is no exception to this.**

Everything else in the product is negotiable. This is not. InsightKit runs inside other people's production databases; a write that escapes the guard is data loss in a system we do not own and cannot restore.

This creates an apparent contradiction the architecture has to resolve rather than hand-wave: the product must also *write* its own metadata (sessions, cached results, migrations). Two independently verifiable guarantees, never one:

- **G1** — SQL derived from a user prompt can only read. Enforced by the `sql-guard` kernel, a dedicated `ik_reader` role with only `GRANT SELECT`, and a sealed read-only transaction.
- **G2** — InsightKit's own metadata writes go through a separate `ik_admin` role, touch only the `insightkit` schema, and never carry user-authored SQL.

`ik doctor --prove-isolation` verifies both against the live catalog. Neither is taken on trust.

## Architecture: the trust boundary is a package boundary

The component that decides whether SQL is safe is a standalone package that **cannot execute SQL, cannot open a socket, and cannot read the filesystem**. It is auditable in isolation by reading one dependency list.

```
packages/
  sql-guard/    security kernel — pure, zero I/O, deps: pgsql-parser only
  protocol/     shared types + zod schemas (browser <-> server)
  core/         engine — the ONLY package that may import `pg`
  llm/          model provider adapters
  server/       HTTP handlers (next / express / fastify / hono)
  react/        components and hooks — browser only
  cli/          ik init | doctor | migrate
  eval/         the release gate — corpus + harness, never published
```

### Dependency rules — enforced by dependency-cruiser, not by review

| Package | May import | Must never import |
|---|---|---|
| `sql-guard` | `pgsql-parser` and nothing else | `pg`, `node:*`, any `@insightkit/*` |
| `protocol` | `zod` | anything server-side |
| `core` | `protocol`, `sql-guard`, `llm`, `pg` | `react` |
| `llm` | `protocol` | `pg`, `sql-guard` |
| `react` | `protocol` | **`core`** |
| `server` | `core`, `protocol` | `react` |
| `eval` | `sql-guard`, the public API of what it scores | `pg`, `node:*` in `src`; nothing may import `eval` |

Two rows carry real weight:

- **`react` must never reach `core`.** One `import { Engine } from '@insightkit/core'` in a Next.js client component ships the database URL into the browser bundle. Defended three ways: `server-only` in `core`'s entrypoint, an `exports` map with no mixed root barrel, and a CI rule.
- **`llm` must never reach `sql-guard`.** The code that talks to an untrusted model does not sit next to the code that decides what is trusted. Model output crosses that gap as a string and returns as a verdict.

### Kernel rules (`packages/sql-guard`)

1. **Allowlist, never denylist.** Unknown AST node tag → deny. A denylist is fail-open against future Postgres syntax: bump the parser, a new node type isn't on the list, the hole opens silently during a routine upgrade. An allowlist turns that same upgrade into a loud test failure.
2. **`guard()` never throws.** A thrown exception is a bypass waiting for somebody's `try/catch`. Parse failure, unknown node, internal error — all return a deny verdict.
3. **It cannot execute.** It returns a string it considers safe; a different package runs it. The kernel does not know a database exists.
4. **Execute our own deparsed SQL, never the model's text.** The guard re-emits SQL from the AST it validated, so what runs is provably what was inspected.
5. **The corpus is a gate.** Tests assert a minimum case count, so quietly deleting an inconvenient attack case fails CI.

Changes under `packages/sql-guard/**` require review via CODEOWNERS.

## Conventions

- **Comments: almost none.** Only when genuinely non-obvious, and then one line. No block comments, no banners, no restating the code. Explanation belongs in `docs/learn/` or an ADR. Applies to config files too.
- TypeScript strict, ESM, Node >= 20.11.
- Named exports. No default exports.
- Errors as return values in the kernel; exceptions elsewhere are fine.
- Apache-2.0 (explicit patent grant matters for a security-boundary dependency).

## Layout

```
docs/learn/     concept explanations, written alongside the code
docs/adr/       architecture decision records, numbered
security/       threat model and disclosure policy
e2e/            Testcontainers: real Postgres, real roles, real RLS
```

## Commands

```
pnpm install
pnpm verify      # typecheck + lint + dependency rules + tests. The gate.
pnpm test
pnpm build
```

## The evaluation gate (`packages/eval`)

Accuracy is the product's central risk, and it is invisible without measurement. The corpus is built **before** the planner, so "does it work" is a number rather than an impression.

1. **Two adversarial surfaces, not one.** `guard` cases are SQL text hitting the validator — deterministic, free, every commit. `system` cases are prompts travelling the whole path — non-deterministic, costed, gated separately. See ADR 0003.
2. **Known gaps are asserted open.** A case nothing blocks yet carries `blockedBy` and a test asserting it is *still* allowed, so closing the gap fails the build and forces reclassification. `blockedBy` values are the remaining security roadmap: `column-policy`, `tenant-scoping`, `row-cap`, `cost-ceiling`, `planner-hardening`.
3. **Grade by execution, as a multiset.** Set equality hides a missing `DISTINCT`. Quantise numbers so equality is transitive, then compare exactly; the boundary artefact fails closed.
4. **Three outcomes.** `INFRA_ERROR` is excluded from the denominator and capped, past which the run is `INCONCLUSIVE`. Retry transient errors only — never retry a wrong answer into a pass.
5. **A spend cap needs bounded concurrency.** `Promise.all` over the corpus dispatches everything before the first cost returns, so the cap can never fire.
6. **`eval/src` is pure.** The clock and all I/O are injected, so scoring re-runs from a results file without re-spending tokens.
7. **Tiers have minimum sizes.** The gate cannot be made green by making it smaller.

## The reader path (`packages/core`)

Core is where G1 stops being a claim about SQL text and becomes a claim about the database.

1. **Capabilities, not conventions.** `asReaderSource` wraps a pool and exposes only `connect()`, so there is no `query()` to bypass the sealed transaction with. `ReaderSource` and `AdminSource` are distinct types.
2. **A guarded query cannot be fabricated.** `approve()` is the only producer. The brand is a real runtime symbol, so a plain object fails to compile and a cast fails at runtime. What is left is a greppable `as` in a CODEOWNERS-gated file.
3. **The transaction is sealed and never commits.** `BEGIN READ ONLY`, `SET LOCAL` for every setting, `SHOW transaction_read_only` to make the server confirm, then `ROLLBACK` unconditionally. `COMMIT` appears nowhere in the reader path and a test asserts it.
4. **`SET LOCAL`, never `SET`** — a session setting leaks onto the next borrower of a pooled connection.
5. **`pg_temp` is off the search path** — a writable temp schema on the path is the CVE-2018-1058 shadowing vector.
6. **Fail closed on interpolation.** `SET LOCAL` cannot take bind parameters, so identifiers are validated against a strict pattern and timeouts against a range. Throw, never escape.
7. **A check that could not run is a failure.** Otherwise a locked-down database produces a green proof by refusing to answer.
8. **No driver dependency.** Core defines the client shape structurally, so it is testable without a database and a second driver is an interface implementation rather than a rewrite. Rows must be arrays: object rows collapse `SELECT a.id, b.id` to one key. The node-postgres adapter lives behind the `@insightkit/core/pg` subpath with `pg` as an *optional* peer dependency, so the main entry never references a driver.
9. **Lossy driver conversions cross the boundary as text.** node-postgres turns a `date` into a JS `Date` at local midnight, so `2026-09-05` serialises to the 4th anywhere east of UTC — a wrong axis with no error, dependent on the server's timezone. `date`, `time`, `timestamp`, `interval`, `bytea` and `numeric[]` are returned as the text Postgres sent; everything the driver gets right is left alone. The registry is per-query — `pg.types.setTypeParser` is global and would change the host application's own queries. See ADR 0007.

## State

`sql-guard` (security kernel), `eval` (release gate) and `core` (reader path, isolation proofs, provisioning) are built and green. Nothing is published to npm.

Not started: `protocol`, `llm`, `server`, `react`, `cli`.

**Nothing has run against a real Postgres.** Core is tested against a recording fake and, for the adapter, against node-postgres' own `Result` parser — which proves what we send, what we refuse, and how the driver converts, but not how a server responds. `pnpm --filter @insightkit/core smoke` turns the outstanding claims into observations against a live database; it is the first thing to run once one exists. Testcontainers e2e remains the highest-value work.

Still asserted open in the eval corpus: `column-policy` (T4-S01), `tenant-scoping` (T4-S02), `cost-ceiling` (T4-S04), `planner-hardening` (T4-S05/S06).
