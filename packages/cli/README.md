# insightics-cli

`ik` — three commands for a human at a terminal. `init` prints the SQL a DBA runs to create Insightics' roles, `doctor` proves against the live catalog that the reader cannot write, `introspect` prints the schema the reader can see.

## The boundary

`insightics-core` is the only workspace package the CLI depends on; its other imports are `node:*` and, dynamically, `pg`. Three dependency-cruiser rules apply, each confirmed to fire by writing the offending import into a scratch tree and cruising it:

- `nothing-imports-the-cli` — no package may import `packages/cli/`. It is a leaf: a front end over `core` for a person at a terminal, never a library another package builds on.
- `cli-never-reaches-the-browser` — `packages/cli/src` must not reach `packages/react/`. The CLI holds connection material and runs on a developer machine; it has no business in a bundle.
- `core-is-the-only-database-package` — which also applies here. A static `import { Pool } from 'pg'` anywhere in `packages/cli/src` fails CI. The driver is reached instead through `await import(DRIVER)` with `DRIVER` a non-literal const, resolved when a command actually needs a connection. `core` stays the one place a connection is opened, and the CLI gets its pool from `fromPgPool` on the `insightics-core/pg` subpath.

## Install

```sh
npm install insightics pg
```

Not published on its own: `insightics` installs the `ik` command, so `npx ik doctor` works in any project that depends on it. `pg ^8.11.0` is an **optional** peer dependency. `ik init` connects to nothing and needs no driver at all; `ik doctor` and `ik introspect` exit 3 with `this command needs node-postgres, which is an optional peer dependency` when `pg` is absent.

## Usage

```sh
ik init --database app --owner app_owner > provision.sql

DATABASE_URL=postgres://admin:…@host:5432/app ik doctor
DATABASE_URL=postgres://admin:…@host:5432/app ik introspect > schema.sql
```

There is **no `--database-url` flag**, deliberately. Argv is visible in `ps` and lands in shell history, and scrollback is forever. Use `--url-env NAME` to read a different variable; the default is `DATABASE_URL`. Neither command prints the connection URL or a password. Role names do appear — `ik doctor` names the roles under test and `ik introspect` labels its output with the role `current_user()` reported — and `src/redact.ts` deliberately leaves them alone, because redacting a role name would blank the report it is supposed to produce.

`ik --help`, `ik <command> --help` and `ik --version` all exit 0. The full flag list for each command is in its own help; the commands are exactly `init`, `doctor` and `introspect`.

## Exit codes

From `src/errors.ts`. `ik doctor`'s exit code is the product — it is what CI reads.

| Code | Constant | Meaning |
|---|---|---|
| 0 | `EXIT_OK` | the command did what it was asked |
| 1 | `EXIT_NOT_PROVEN` | `ik doctor` ran and the proof did not hold |
| 2 | `EXIT_USAGE` | a bad flag, a bad value, or an identifier `core` refused |
| 3 | `EXIT_CANNOT_RUN` | nothing was proven or printed: no URL, no `pg`, no connection, a catalog query that never came back — and any unexpected throw |

1 and 3 are different claims on purpose. A proof that failed is a finding about your database; a proof that could not run is not. Observed by running the built binary: `ik doctor` with `DATABASE_URL` unset exits 3, `ik doctor --timeout 5` exits 2, `ik nope` exits 2, and `ik init --valid-until nope` exits 2.

## What defines it

**The exit code is the point, and "could not run" is not "failed".** A proof that never ran — no URL, no driver, no connection, `proveIsolation` throwing — becomes a `CannotRunError` and exit 3, because exit 1 would be a finding about your database and this is not one. Inside the proof the rule inverts: a single check that could not run counts as a failure, so a locked-down catalog cannot earn a green proof by refusing to answer. `--strict` promotes review findings to exit 1 as well. The report names the checks and, when check A0 blocks, says in full why the rest of the run cannot be trusted: `ik doctor` connected as a role it is testing, and the privilege views under-report from inside.

**Two redactors, not one.** `redact` (and `redactorFor`) is aggressive — URL credentials, secret query parameters, anything key-shaped — and is used on error text only. `secretRedactorFor` strips the exact URL and password literals and nothing else, and it is the only one run over anything read back from the database. That split exists so a table named `token_expires_audit` survives into the DDL intact instead of being rewritten into `[redacted]`, which would corrupt exactly what the model is later told. [ADR 0008 — Introspection describes what the reader can see](../../docs/adr/0008-introspect-through-the-readers-eyes.md) is why that output matters.

**`ik init` prints, it does not run, and it holds no password.** A credential echoed to a terminal lives on in scrollback and in the CI log, so the script says `\password ik_sdk` instead. The output is split into a scoped section and a cluster-wide section that changes privileges held by `PUBLIC`; `--scoped-only` omits the second and writes a warning to stderr saying that `ik doctor` does not cover it, so a database that skips it still proves clean. It also warns when it had to assume `--database` or `--owner`.

**`runCli` never throws, and `bin.ts` sets `process.exitCode` rather than calling `process.exit`.** Every failure leaves as a line on stderr and a number. `process.exit()` drops whatever stdout has not flushed, which would truncate the DDL the moment `ik introspect` is piped anywhere.

## What it does not do

- **There is no `ik migrate`, and no `--prove-isolation` flag.** Both have been documented elsewhere in this repo and neither exists: `ik migrate` exits 2 with "no command called", `ik doctor --prove-isolation` exits 2 with "Unknown option". `ik doctor` proves isolation with no flag at all.
- **It has never been run against a real Postgres.** Every test injects a fake `Opener` whose client records statements and returns canned rows, plus a buffered `Output`. The suite asserts the first statement is `BEGIN READ ONLY` and the last is `ROLLBACK`; what a real server does with them is unobserved.
- **It writes nothing, ever.** Both database commands run inside core's sealed read-only transaction, and `ik init` opens no connection.
- **Without `--strict`, missing row security does not fail the run.** The row-security checks (T1–T4) are review findings, because the CLI has no way to know tenant scoping is in use — `isolationChecks({ tenantScoping: true })` in core makes T1 and T2 blocking, and no flag sets it yet. A database with row security off on every table therefore exits 0. A multi-tenant deployment should run `ik doctor --strict`.
- **`ik doctor` does not check the cluster-wide section of `ik init`.** Those grants are the ones that fence off `PUBLIC`, and a database that never ran them still proves clean. `ik init` says so in the script and again on stderr.
- **`ik init` does not create anything and does not run migrations.** Creating a schema inside somebody else's production database is a change their change log cannot explain.
