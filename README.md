# InsightKit

Prompt-driven, real-time analytics you can embed in a Node application in an afternoon.

Point it at your Postgres database, drop a component into your admin panel, and your users ask questions in plain language — *"how many users joined this week, split by signup method"* — and get a live chart back. No API to write, no dashboard to wire up, no component to design.

> **Status: pre-alpha.** Nothing is published to npm. The security kernel works and is tested; the rest is being built in the open.

## The constraint everything is built around

**SQL derived from a user prompt can only read. There is no exception.**

InsightKit runs inside your production database. A write that escapes would be data loss in a system we do not own and cannot restore. So the read-only guarantee is not a setting, a policy or a code review convention — it is four independent mechanisms, none of which is load-bearing alone:

| Layer | Enforces |
|---|---|
| `sql-guard` | one statement, must be `SELECT`, allowlisted node types, fields and functions |
| Deparse round-trip | what executes is re-emitted from the validated tree, never the input string |
| `ik_reader` role | `GRANT SELECT` only — there is no write privilege to escalate to |
| Sealed read-only transaction | `BEGIN READ ONLY`, sealed, always rolled back |

`ik doctor --prove-isolation` verifies the database-side guarantees against the live catalog rather than asking you to trust them.

## The security kernel

The component that decides whether SQL is safe is a package that **cannot execute SQL, cannot open a socket, and cannot read the filesystem**. It takes a string and returns a verdict. Something else runs the query.

```ts
import { createGuard } from '@insightkit/sql-guard';

const guard = await createGuard({ allowedSchemas: ['public'] });

guard('SELECT count(*) FROM users');
// { ok: true, sql: 'SELECT count(*)\nFROM users', tables: [{ schema: null, name: 'users' }] }

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
- **Its entire transitive dependency tree is 7 packages.** Auditable in a minute.

Validation uses `libpg_query` — Postgres's own parser, compiled to WebAssembly. When it says a statement is a `SELECT`, that is the same judgement the database will make.

## Architecture

The trust boundary is a package boundary, enforced in CI rather than by review.

```
packages/
  sql-guard/    security kernel - pure, zero I/O
  protocol/     shared types (browser <-> server)
  core/         engine - the only package that may import `pg`
  llm/          model provider adapters
  server/       HTTP handlers (next / express / fastify / hono)
  react/        components and hooks - browser only
  cli/          ik init | doctor | migrate
```

`react` may never import `core` — one such import in a Next.js client component would ship your connection string into the browser bundle. `llm` may never import `sql-guard` — the code talking to an untrusted model does not sit beside the code deciding what is trusted.

## Development

```bash
pnpm install
pnpm verify     # typecheck + dependency rules + tests
```

`pnpm verify` is the gate. It runs the full adversarial corpus, which must pass at 100%.

## Documentation

- [docs/learn](./docs/learn) — how this works and why it is shaped this way, written alongside the code
- [docs/adr](./docs/adr) — decisions with a real alternative, and the reasoning
- [SECURITY.md](./SECURITY.md) — reporting, scope, and what counts as a vulnerability

## Contributing

Changes under `packages/sql-guard/` alter the read-only guarantee and get reviewed as such. New attack cases in `packages/sql-guard/test/corpus/attacks.json` are the single most valuable contribution — a case that currently *passes* the guard is a bug report we would very much like to receive.

## Licence

Apache-2.0.
