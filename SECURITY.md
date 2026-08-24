# Security policy

InsightKit runs inside other people's production databases. A vulnerability here is a vulnerability in their systems, so we would rather hear about a suspected issue that turns out to be nothing than miss a real one.

## Reporting

Report privately through GitHub's security advisory form on this repository. Do not open a public issue for a suspected vulnerability.

Include what you did, what happened, and what you expected. A failing SQL string is the most useful thing you can send.

**There is no bug bounty.** We would rather say so plainly than imply one exists.

## What we consider a vulnerability

Highest severity, in order:

1. SQL derived from a user prompt that reaches the database and performs a write, DDL, privilege change, filesystem access, or outbound network call.
2. Any input that causes `guard()` to throw instead of returning a deny verdict. A thrown exception can be swallowed by a caller's `try/catch` and become a pass.
3. A query permitted by the guard whose emitted SQL differs in meaning from what was inspected.
4. Tenant isolation failure — one tenant reading another's rows or cached results.
5. Credentials reaching the browser bundle.

Denial of service through an expensive but legitimate query is handled by `statement_timeout` and the row cap, not by the guard. Report it if you can exceed those, not if a query is merely slow.

## Scope

In scope: everything under `packages/`.

Out of scope: misconfiguration in a consuming application, such as granting `ik_reader` write privileges, running InsightKit as a superuser, or exposing the server handler without authentication. `ik doctor --prove-isolation` exists to catch these; if it passes while the configuration is unsafe, that **is** in scope.

## How the guarantee is structured

Four independent defences. None is load-bearing alone.

| Layer | Enforces |
|---|---|
| `sql-guard` | statement is a single SELECT, allowlisted nodes, fields and functions |
| Deparse round-trip | what executes is re-emitted from the validated tree, not the input string |
| `ik_reader` role | `GRANT SELECT` only; no write privilege exists to escalate to |
| Sealed read-only transaction | `BEGIN READ ONLY`, sealed, always `ROLLBACK` |

A finding that defeats one layer is still a vulnerability. Please report it even if the others would have caught it.
