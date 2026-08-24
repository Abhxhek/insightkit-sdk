# 01 — What an SDK actually is

An application is code you run. An SDK is code **other people** run, inside programs you will never see, on schedules you do not control. Almost everything that feels fussy about SDK engineering comes from that one difference.

Three consequences shape every decision in this repo.

## 1. You cannot fix a released version

When you ship an app and find a bug, you deploy. When you ship an SDK and find a bug, you publish a new version and then *wait* — for people to notice, upgrade, test, and roll out. Some never will. `1.0.3` keeps running in production somewhere for years.

That is why the security kernel is fully covered by an adversarial corpus before anything is published, and why the corpus has a minimum-size assertion so a case cannot be quietly deleted to make CI green.

## 2. Your public API is a promise you cannot take back

Every exported name is a contract. Rename it and you break strangers' builds. This is what semantic versioning encodes:

- **patch** (`1.0.0 -> 1.0.1`) — behaviour fixed, API unchanged
- **minor** (`1.0.0 -> 1.1.0`) — API added, nothing existing changed
- **major** (`1.0.0 -> 2.0.0`) — something existing changed or disappeared

The practical discipline: **export the minimum**. Every symbol you do not export is one you can freely rewrite. `sql-guard` exports `createGuard`, the types, and the three allowlists (so users can inspect what is permitted). Everything else — the walk, the deparse round-trip, the policy check — is internal and can be redesigned without a major version.

Note also what the `package.json` says:

```json
"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
"files": ["dist"]
```

`exports` means consumers can import `@insightkit/sql-guard` and nothing else. They cannot reach into `dist/guard.js` and depend on an internal — Node refuses. Without it, every file in your package is public API whether you meant it or not. `files` keeps tests and sources out of the published tarball.

## 3. Your dependencies become their dependencies

Install our SDK and you install our entire dependency tree, with our vulnerabilities and our supply-chain surface, into your production database server's process.

This is why the kernel has exactly one direct dependency, and why we checked what that expands to:

```
pgsql-parser -> @pgsql/types, libpg-query, pgsql-deparser, @pgsql/quotes
7 packages total
```

Seven. All from the same org. A reviewer can audit that. Compare a typical Node package with 300 transitive dependencies from 200 maintainers — that is 200 npm accounts whose compromise becomes your compromise.

Two related controls in this repo:

- `pnpm` blocks install-time scripts by default. Every allowed one is an explicit, reviewed line in `pnpm-workspace.yaml`. A postinstall script is arbitrary code execution on every contributor's laptop and in CI.
- `provenance=true` in `.npmrc`, published via CI with OIDC rather than a long-lived token. A stolen publish token on a package that runs inside customer databases is not an inconvenience, it is an incident.

## The async-init, sync-use pattern

Look at how the guard is obtained:

```ts
const guard = await createGuard();
const verdict = guard(sql);
```

Setup is async because the WebAssembly parser must load. Use is **sync**, deliberately.

If `guard()` were async, then somewhere in the product's life a caller writes `if (guard(sql).ok)` without `await`. A Promise is always truthy. `.ok` on a Promise is `undefined`. The check silently passes for every input, including hostile ones. It looks correct, it type-checks under `any`, and it disables the security boundary completely.

A synchronous function cannot be misused that way. Pay the async cost once at construction, hand back something that is hard to hold wrong.

This generalises: **when an API can be called incorrectly and the incorrect call looks plausible, change the API rather than documenting the hazard.** Nobody reads the docs at 2am.

## Errors as values, at the boundary

The kernel returns `{ ok: false, code, detail }` rather than throwing. Two reasons.

An exception can be caught by code that has no idea what it caught. `try { run(sql) } catch { /* ignore */ }` is a real thing people write, and around a security check it converts a deny into a pass.

More usefully, a discriminated union makes the compiler enforce handling:

```ts
const v = guard(sql);
if (!v.ok) return reject(v.code);
await execute(v.sql);
```

`v.sql` does not exist on the deny branch. Skip the check and it does not compile. The type system carries the security invariant, so it survives refactors by people who never read this document.

This is a boundary-layer choice, not a universal one. Inside `core`, ordinary exceptions are fine.

## What to read next

- [02 — Package boundaries as security boundaries](./02-boundaries.md)
- [03 — Deciding whether SQL is safe](./03-parsing-sql-safely.md)
