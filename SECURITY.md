# Security policy

InsightKit runs inside other people's production databases. A vulnerability here is a vulnerability in their systems, so we would rather hear about a suspected issue that turns out to be nothing than miss a real one.

## Reporting

Report privately through GitHub's security advisory form on this repository. Do not open a public issue for a suspected vulnerability.

Include what you did, what happened, and what you expected. A failing SQL string, or a question that produced one, is the most useful thing you can send.

**There is no bug bounty.** We would rather say so plainly than imply one exists.

## What we consider a vulnerability

Highest severity, in order:

1. SQL derived from a user prompt that reaches the database and performs a write, DDL, privilege change, filesystem access, or outbound network call.
2. Any input that causes `guard()` to throw instead of returning a deny verdict. A thrown exception can be swallowed by a caller's `try/catch` and become a pass.
3. A query permitted by the guard whose emitted SQL differs in meaning from what was inspected.
4. Tenant isolation failure — one tenant reading another's rows, given that the operator has written the row-level security policies described below.
5. Credentials reaching the browser bundle, a log line, or an error message.
6. Validator internals reaching a client — a deny code, a rejected statement, or the guard's own wording. These tell an attacker that their probe was detected *and how it was classified*, which turns the error channel into a map of the defence.
7. A write reaching the `insightkit` metadata schema from anything carrying user-authored SQL, or a cached plan that executes without being re-validated.

Denial of service through an expensive but legitimate query is handled by `statement_timeout` and the row cap, not by the guard. Report it if you can exceed those, not if a query is merely slow.

## Scope

**In scope:** everything under `packages/`.

**Out of scope:** misconfiguration in a consuming application — granting `ik_reader` write privileges, running InsightKit as a superuser, or exposing the server handler without authentication. `ik doctor` exists to catch these; if it passes while the configuration is unsafe, that **is** in scope — with one documented exception: it does not check the cluster-wide section of `ik init`, the grants that fence off `PUBLIC`.

**Also out of scope, and important to understand:** tenant scoping is enforced by Postgres row-level security, not by rewriting SQL. The SDK sets a session variable; the database applies the policy. On a table where the operator has **not** written a policy, that variable is inert and every user sees every row — with no error at query time. This is a documented property, not a defect. `ik doctor` reports it as a review finding, which fails the run only under `--strict` — the CLI cannot tell that tenant scoping is in use — so a multi-tenant deployment should run `ik doctor --strict`. The operator must write, on every readable table:

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders FOR SELECT TO ik_reader
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

A *bypass* of a policy that exists is in scope. The absence of a policy is not.

## How the guarantee is structured

Independent defences. None is load-bearing alone, and a finding that defeats one is still a vulnerability even if another would have caught it.

| Layer | Enforces |
|---|---|
| `sql-guard` | a single `SELECT`, allowlisted nodes, fields and functions |
| Deparse round-trip | what executes is re-emitted from the validated tree, not the input string |
| Row cap | clamped into the validated tree, then read back out of the emitted SQL |
| `ik_reader` role | `GRANT SELECT` only; no write privilege exists to escalate to |
| Sealed read-only transaction | `BEGIN READ ONLY`, `SET LOCAL` only, server-confirmed, always `ROLLBACK` |
| Row-level security | enforced by Postgres on every access path, including subqueries and CTEs |
| The wire contract | failures cross as coarse statuses; deny codes and token counts do not |

A second guarantee runs beside the first: InsightKit's own metadata writes use a separate role, touch only the `insightkit` schema, and never carry user-authored SQL. A cached plan is re-validated through the guard on the way out, so a tampered metadata row cannot produce unguarded SQL.

## What has and has not been verified

Being explicit, because it changes how much weight to put on the above.

**Verified by execution:** the guard's behaviour against its adversarial corpus, which is pure text analysis and needs no database. The driver's type conversions, checked against node-postgres itself. The dependency boundaries, each confirmed by introducing a violation and watching CI fail.

**Not verified against a live system:** everything that depends on a server responding. `BEGIN READ ONLY` refusing a write, the provisioning script's grants, the catalog queries, the row-level security checks, and every claim about how Postgres behaves are reasoned about and parse-checked, not observed. No Testcontainers suite exists yet.

Treat the database-side layers as designed rather than proven until that changes.
