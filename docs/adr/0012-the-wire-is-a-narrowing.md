# ADR 0012 — The wire is a narrowing, not a re-export

Status: accepted, 2026-09-27

## Context

`packages/protocol` defines what travels between a browser and the server. The tempting implementation is to re-export the types the server already has: `PlanResult` carries a chart, rows, a reason and a deny code, and it would be one line to publish it.

That one line is a disclosure. The server knows things a client must not learn.

| The server holds | Why a browser must not see it |
|---|---|
| `E_NOT_SELECT`, `E_MULTI_STATEMENT` | Tells an attacker their probe was detected **and classified**. That is a free oracle for mapping the validator. |
| Token counts, model name | The host's cost structure and vendor, exposed to their customers. |
| Attempt history | Reveals that a first attempt was rejected and why. |
| The SQL | Schema names introspection deliberately filtered by privilege. |

## Decision

**The wire types are written independently and are deliberately lossy.** A failed answer crosses as one of three coarse statuses with a human-readable message and nothing else.

- `unanswerable` carries the model's own reason. Safe: it describes a schema the user is already querying.
- `refused` carries a **generic** message. Never a deny code.
- `error` carries a generic message.

**Objects are strict, not stripping.** zod strips unknown keys by default, which would silently discard a leaked `code` field at parse time — but by then the JSON has already crossed the network, so stripping protects nothing. Strict's value is on the **sending** side: a server that validates its own response before serialising turns a leak into a 500 rather than a disclosure. That only works if an unknown key is an error. The cost is that adding a field is a breaking change needing a `PROTOCOL_VERSION` bump; that is the intended discipline.

**Every response carries the protocol version**, so a stale browser bundle reports a version mismatch instead of misparsing. A helper reads the version without validating, so the client can say "the server speaks protocol 2" rather than "parse error" — which is the only reason a version field earns its place.

**`Date` cannot appear anywhere.** ADR 0007 made the pg adapter return dates, timestamps, intervals, bytea and non-finite floats as the text Postgres sent. The wire schema rejecting `Date` is that decision being enforced one layer up rather than restated.

**A row whose length differs from `columns.length` is rejected.** A column-shifted table renders as a confident wrong chart, which is this product's worst failure mode.

**Control characters are rejected in free text that becomes a prompt (`question`) or that is a branch's entire payload (`message`), using the repo's existing allowlist of tab, newline and carriage return.** They are *not* rejected in text that merely decorates good data — a chart title, a column name, a string cell — because a quoted Postgres identifier may legitimately contain anything, and discarding a correct answer over a title is the wrong trade.

## Consequences

`core`'s `ResultSet.columns` is `readonly string[]` and will not assign to protocol's `string[]`. The server must copy. Since it must validate cell-by-cell at that boundary anyway, the copy is free.

`refused` and `error` are shape-identical. Correct for the threat model, but nothing in the type system stops a server author writing a deny code into `message`. No test can catch that; it needs a reviewer's eye on the server handler.

The request carries only `question`. Tenancy travels beside it, not inside it — see ADR 0013. With strict objects, changing that later costs a version bump.

`truncated` is a boolean, not a count. The user sees a clipped chart without knowing how much is missing, even though `ReadResult` knows the limit.

Unicode format characters — bidi overrides, zero-width spaces — are **not** rejected. That is a real prompt-obfuscation gap, left asserted open rather than half-closed.
