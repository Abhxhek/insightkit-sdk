# insightics-sql-guard

The Insightics security kernel. It takes a SQL string and returns a verdict: either SQL it is prepared to vouch for, or a deny code and a reason. It cannot run the query.

## The boundary

The kernel depends on `pgsql-parser` and nothing else. It may not import `pg`, any Node builtin that performs I/O, or any sibling `insightics-*` package. Two rules in [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs) enforce that in CI rather than in review:

- **`kernel-no-io`** — no `fs`, `net`, `http`, `https`, `child_process`, `dgram`, `tls`, `dns`, `worker_threads`, `vm`, `cluster`, no `pg*`, no `axios`/`undici`/`node-fetch`.
- **`kernel-no-siblings`** — no other workspace package.

The reason is not tidiness. The component that decides whether SQL is safe must not be able to *act* on that decision — it returns a string and a different package runs it — and it has to be auditable without reading the rest of the repository. `pnpm --filter insightics-sql-guard list --prod --depth Infinity` reports **7 packages** — five distinct ones, since `@pgsql/types` is counted three times — all of them the Postgres parser and its parts. That is the whole trusted base.

Changes here are gated by [`CODEOWNERS`](../../CODEOWNERS), as is [`test/corpus/`](./test/corpus).

## Install

```bash
pnpm add insightics-sql-guard
```

No peer dependencies. ESM only; the repository's engine floor is Node >= 20.11.

## Usage

```ts
import { createGuard } from 'insightics-sql-guard';

// async once: this loads libpg_query, Postgres 18's own parser compiled to WebAssembly
const guard = await createGuard({ allowedSchemas: ['public'], maxRows: 1000 });

guard("SELECT count(*) FROM users WHERE created_at > now() - interval '7 days'");
// {
//   ok: true,
//   sql: "SELECT count(*)\nFROM users\nWHERE\n  created_at > (now() - '7 days'::interval)\nLIMIT 1000",
//   tables: [ { schema: null, name: 'users' } ],
//   rowLimit: 1000
// }

guard('SELECT 1; DROP TABLE users');
// { ok: false, code: 'E_MULTI_STATEMENT', detail: '2 statements; exactly 1 permitted' }

guard('SELECT * INTO exfil FROM users');
// { ok: false, code: 'E_FIELD_NOT_ALLOWED', detail: 'field not allowed on SelectStmt: intoClause' }

guard("SELECT pg_read_file('/etc/passwd')");
// { ok: false, code: 'E_FUNCTION_NOT_ALLOWED', detail: 'function not on allowlist: pg_read_file' }

guard('SELECT id FROM other.users');
// { ok: false, code: 'E_SCHEMA_NOT_ALLOWED', detail: 'schema not allowed: other' }
```

`Verdict` is a discriminated union: `ok: false` carries no `.sql`, so the compiler rejects code that forgets to check. The public surface is `createGuard`, the `ALLOWED_TAGS` / `ALLOWED_FIELDS` / `ALLOWED_FUNCTIONS` tables, and the types in [`src/types.ts`](./src/types.ts) — 15 deny codes and a four-field `Policy` (`allowedSchemas`, `allowedTables`, `maxDepth`, `maxRows`).

## What defines it

**Allowlist, never denylist.** An unknown AST node tag is a denial. A denylist fails open against future Postgres syntax: bump the parser, a new node type is not on the list, and the hole opens silently during a routine upgrade. The allowlist turns that same upgrade into a loud test failure. Currently 37 node tags, a per-tag field table for the same 37, and 119 functions. See [ADR 0001 — Allowlist AST node types rather than denylist them](../../docs/adr/0001-allowlist-over-denylist.md).

**One check is not enough.** Tag allowlisting alone permits `SELECT * INTO exfil FROM users`, because libpg_query inlines `intoClause` as a bare struct with no tag of its own; and it permits `pg_read_file()`, because the danger there is data inside a legitimate `FuncCall`. Hence separate layers for statement shape, node tags, per-tag fields, function names and the raw input bytes. See [ADR 0002 — The guard needs independent layers, not one](../../docs/adr/0002-three-layer-guard.md).

**The row cap is clamped into the validated tree, then read back out of the emitted SQL.** Not wrapped around the query — wrapping would be string construction outside the guarantee, and it would turn a top-20 query into a top-1000 one. `LIMIT $1` and `FETCH FIRST n ROWS WITH TIES` are denied rather than capped. See [ADR 0005 — The row cap is applied to the validated tree, not around it](../../docs/adr/0005-row-cap-in-the-validated-tree.md).

**`guard()` never throws, and what it returns is its own output.** An exception is a bypass waiting for somebody's `try/catch`, so parse failures, unknown nodes and internal errors all come back as verdicts. The returned `sql` is deparsed from the tree that was inspected and then re-inspected, so obfuscation that was never in the AST cannot survive into what executes.

## What it does not do

- **It does not connect to anything.** The row cap travels inside the SQL it emits, so it is Postgres that enforces it — if anyone ever runs that SQL. Execution, roles and read-only transactions live in `insightics-core`.
- **It does not know your schema.** `allowedSchemas` / `allowedTables` are string comparisons against names in the parse tree. It cannot tell you a table exists, and it does no column-level policy at all — that gap is tracked as `column-policy` in the eval corpus.
- **It does not bound cost.** A capped cross join still executes. That is `cost-ceiling`, also still open.
- **It does not sanitise.** There is no repair, no rewriting of a hostile query into a safe one, no escaping. The only outcomes are the deparsed SQL or a denial.
- **It has never been run against a live Postgres.** Validation is the parser's judgement about a string. The corpus — 58 adversarial cases and 30 legitimate ones in [`test/corpus/`](./test/corpus), with the counts asserted as a floor so an inconvenient case cannot be deleted quietly — is the whole of the evidence. Run it with `npx vitest run packages/sql-guard` from the repo root.
