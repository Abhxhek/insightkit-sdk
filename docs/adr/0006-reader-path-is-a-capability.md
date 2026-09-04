# ADR 0006 — Reaching the database is a capability, not a convention

Status: accepted, 2026-09-04

## Context

`sql-guard` decides whether SQL is safe. Nothing so far stopped a caller from ignoring it — taking a connection pool and running whatever string they liked. The guarantee was "everyone remembers to call the guard", which is the class of defence this project exists to avoid.

Two mistakes are foreseeable, and neither is malicious. Someone grabs the admin pool because it is in scope. Someone writes `runRead(pool, { ok: true, sql })` to skip validation "just for an internal query".

## Decision

**Connection sources are branded and wrapped.** `asReaderSource(pool)` returns a new object exposing only `connect()`, carrying a non-enumerable symbol. Wrapping rather than tagging matters: a driver pool also exposes `query()`, and handing that straight through would leave a path to the database that bypasses the sealed transaction entirely. The wrapper removes it.

`ReaderSource` and `AdminSource` are distinct types, so passing one where the other belongs is a compile error rather than a production incident.

**Guarded queries are unforgeable in both directions.** `approve()` is the only producer of a `GuardedQuery`. The brand is a real runtime symbol, not a phantom type, so the two plausible bypasses both fail:

- a plain object does not type-check
- an object *cast* to `GuardedQuery` type-checks, then fails at runtime because the symbol is not actually on it

A cast is the remaining path, and a cast is greppable in a diff that CODEOWNERS already gates. An object literal is not.

**The transaction is sealed and never commits.**

```
BEGIN READ ONLY
SET LOCAL statement_timeout / lock_timeout / idle_in_transaction_session_timeout
SET LOCAL row_security = on
SET LOCAL search_path = pg_catalog, public
SHOW transaction_read_only          -- the server confirms, we do not assume
<the deparsed sql>
ROLLBACK                            -- always, including on success
```

`ROLLBACK` on the success path is deliberate. A read-only transaction has nothing to commit, and rolling back unconditionally means **`COMMIT` never appears anywhere in the reader path** — an invariant a test asserts directly, and one a reviewer can check by grep.

`SET LOCAL` rather than `SET` scopes every setting to the transaction, so nothing leaks onto the next borrower of a pooled connection. `pg_temp` is left off the search path because a writable temp schema on the path is the CVE-2018-1058 function-shadowing vector.

`SHOW transaction_read_only` costs one round trip and converts "we sent `BEGIN READ ONLY`" into "the server agrees this transaction cannot write". There is no option to disable it; a defence with a switch gets switched off.

## Consequences

- `SET LOCAL` cannot take bind parameters, so its values are interpolated. Timeouts must be integers in range and schema names must match a strict identifier pattern, both enforced by throwing rather than escaping. Fail closed on anything unusual.
- `core` declares no driver dependency at all. It defines the client shape structurally, which keeps it testable without a database and makes a second driver an implementation of an interface rather than a rewrite.
- Rows must arrive as arrays, not objects. `SELECT a.id, b.id` collapses to a single key under object rows, silently losing a column.
- If `ROLLBACK` fails the connection is discarded rather than returned to the pool, because its transaction state is then unknown.
