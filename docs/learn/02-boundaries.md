# 02 — Package boundaries as security boundaries

## The idea

A folder is a suggestion. A package is a wall.

If the SQL validator lives in `src/lib/security/guard.ts`, then any file in the project can import anything into it, and any file can import around it. Whether that happens depends on whether every future contributor understands why they shouldn't. That is not a boundary, it is a hope.

If it lives in `packages/sql-guard` with its own `package.json`, then its dependency list is a short public document, its API is whatever `exports` says and nothing more, and "does the validator have filesystem access?" is answered by reading four lines instead of tracing an import graph.

**Design rule: whenever a component's trustworthiness is the thing you care about, make it a package.**

## Why monorepo rather than separate repos

Separate repos would enforce the same walls, and cost far too much. A change spanning the guard and the engine becomes two PRs, two releases, and a version-compatibility matrix. You would stop making cross-cutting improvements because the friction is too high.

A monorepo keeps one PR, one test run, one atomic change — and we get the walls back with tooling instead of geography.

## pnpm, and why the strictness is the feature

npm and yarn install dependencies flat: everything ends up in one top-level `node_modules`. So if `A` depends on `lodash` and `B` does not, `B` can still `import lodash` and it works. This is a **phantom dependency** — it works on your machine, works in CI, and breaks when `A` drops `lodash` in a patch release.

pnpm uses a nested store with symlinks: a package can only import what its own `package.json` declares. We hit this immediately — the API probe script failed with `ERR_MODULE_NOT_FOUND` until it was moved inside `packages/sql-guard`, because only that package declares `pgsql-parser`.

For a security kernel this is exactly what you want. "One dependency" is enforced by the resolver, not just written down.

## The rules, and why these ones

```
sql-guard  ->  pgsql-parser, and nothing else
protocol   ->  zod
core       ->  protocol, sql-guard, llm, pg
llm        ->  protocol
react      ->  protocol
server     ->  core, protocol
```

Three of these carry real weight.

### `react` must never import `core`

`core` holds the database pool. In a Next.js app, one `import { Engine } from '@insightkit/core'` inside a component that turns out to be a client component means the bundler follows that import into the browser bundle — and the connection string goes with it.

The developer who does this will not be us. It will be someone six months from now who wanted a type and grabbed the wrong import. It will look fine in dev. It will ship.

Three independent defences, because one is not enough for a failure this quiet:

1. `server-only` imported in `core`'s entrypoint — the Next.js build hard-fails.
2. An `exports` map with no shared root barrel, so there is no import path that reaches both.
3. A dependency-cruiser rule in CI.

### `sql-guard` must not reach a socket, a file, or a sibling

The component that *decides* whether SQL is safe must not be able to *act* on that decision. Give it a database handle and the boundary blurs: someone adds a "just check this against the catalog" query, and now the validator has a connection, and now a bug in the validator is a bug with database access.

Keep it a pure function. String in, verdict out. Some other package executes.

### `llm` must not reach `sql-guard`

The code talking to an untrusted model does not sit next to the code deciding what is trusted. Model output crosses that gap as a plain string and comes back as a verdict — never as an object the model influenced the shape of.

## Making the rules real

Written rules decay. This one is checked:

```
$ npx depcruise packages --config .dependency-cruiser.cjs
✔ no dependency violations found (10 modules, 14 dependencies cruised)
```

And we verified it actually fires by writing a deliberate violation:

```ts
// packages/sql-guard/src/__violation.ts
import { readFileSync } from 'node:fs';
```

```
error kernel-no-io: packages/sql-guard/src/__violation.ts → fs
x 1 dependency violations
```

**Always test that your control fails when it should.** A rule that has never rejected anything is indistinguishable from a rule with a typo in its glob. This one has now been observed doing its job.

## The pattern to take away

Ask "what must be true no matter who edits this next year?" Then find the mechanism that makes it true without requiring them to know:

| Invariant | Weak mechanism | Mechanism used here |
|---|---|---|
| Guard has no I/O | code review | dependency-cruiser rule in CI |
| Guard has one dependency | documentation | pnpm strict resolution |
| Browser never gets the pool | naming convention | `server-only` + `exports` + CI rule |
| Deny branch is handled | remembering to | discriminated union, compiler-enforced |
| Attack cases stay in the corpus | good intentions | minimum-count assertion in the test |

The left column is where security decays. The right column is where it holds.
