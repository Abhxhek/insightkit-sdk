# ADR 0013 — Tenant isolation is Postgres's job, not ours

Status: accepted, 2026-09-27

## Context

One customer's end users must not see another customer's rows. The product already injects a row cap into the validated parse tree, so injecting `WHERE tenant_id = $x` the same way looks like the obvious next step.

It is not equivalent. The row cap is a top-level clause on a statement we have already shaped. A tenant predicate has to hold on **every** relation reference — inside a subquery, inside a CTE, inside each branch of a `UNION`, behind a view, in a lateral join. Covering all of them exhaustively is a research project, and the failure mode is one customer reading another's data with no error raised.

Postgres already solved this. Row-Level Security is enforced by the database on every access path, including the ones a rewriter would miss.

## Decision

**We do not rewrite SQL for tenancy.** A verified identity becomes a session setting; the database enforces the policy.

```
verify JWT  ->  tenant id  ->  SET LOCAL app.tenant_id = '...'  ->  Postgres applies the policy
```

Two pieces already existed: `sessionPreamble` emits `SET LOCAL row_security = on`, and doctor check A3 fails a role carrying `BYPASSRLS`.

**`jose`'s defaults are not safe, and each was confirmed by running it rather than reading about it:**

| Default behaviour | Consequence | What we do |
|---|---|---|
| A token with no `exp` verifies | A forever-token with a valid signature | `requiredClaims: ['exp']`, always |
| A 5-byte HS secret signs and verifies | Offline-brute-forceable signing key | Reject secrets under 32 bytes at config time |
| `createRemoteJWKSet` accepts `http://` | Keys fetched over plaintext are attacker-supplied, making verification theatre | Reject any non-https JWKS URL |

The algorithm allowlist is explicit and never taken from the token's own header. With no allowlist, an algorithm-confusion token produces a bare `TypeError` rather than a typed rejection — so the allowlist matters for error *handling* as much as for security.

**A missing or empty tenant claim is a hard failure, never an empty scope.** Failing open here is one customer seeing another's data.

**A setting name must be exactly `prefix.name`, two plain lowercase identifiers.** The dot is mandatory because an *unprefixed* name is a built-in GUC: without that rule, a scope setting could target `row_security` or `search_path` and undo the preamble it travels with. Lowercase because Postgres folds unquoted identifiers, and the emitted name must match the string the customer's policy passes to `current_setting()`.

**Values reject backslashes, control characters, surrounding whitespace, and anything over 256 characters.** Doubling a quote is only sufficient while `standard_conforming_strings` is on — the host's setting, not ours. Rejecting backslashes removes the dependency rather than asserting it. Whitespace is rejected rather than trimmed, because trimming silently merges `'t1'` and `' t1'` into one tenant.

**Validation runs twice on purpose**: once when the scope is built, for precise error codes, and again in `execute.ts` at the point SQL is emitted, so a hand-built setting handed straight to `sessionPreamble` still cannot produce a bare `SET`. Same shape as `approve`/`isGuardedQuery`.

**The new doctor checks are conditionally blocking.** They block only when the host declares `tenantScoping: true`; otherwise they downgrade to review rather than going silent. Always-blocking turns every single-tenant install red and gets doctor ignored; always-advisory lets a multi-tenant install ship green.

## Consequences — read this part

**A table where the customer never wrote a policy is completely unprotected.** `SET LOCAL app.tenant_id` sets a variable that nothing reads. If `relrowsecurity` is false, the setting is inert and every end user sees every row, with no error at query time. The SDK cannot detect this; only `ik doctor` can.

The customer must do this on **every** readable table, in their own migrations, and run doctor in CI so a new table cannot ship without it:

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders FOR SELECT TO ik_reader
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

That is a real adoption cost, and it is the honest price of not pretending a rewriter is safe.

**Nothing currently requires a scope to be passed.** `runGuardedRead(source, query)` with no scope runs unscoped. That is the largest remaining fail-open. It is not fixable in `core` alone — a single-tenant install legitimately has no scope — so it belongs in `server`, which is where a request maps to a tenant.

**RLS on with no matching policy returns zero rows, not an error.** The user sees an empty chart and believes it. A doctor check flags the configuration; nothing catches it at query time.

**Doctor is a point-in-time snapshot.** `ALTER DEFAULT PRIVILEGES` grants SELECT on future tables, so a table created next week is readable and unscoped until someone re-runs the proof.

**A verified signature is not a true claim.** If the identity provider mints a token with an attacker-controlled tenant claim, or its signing key leaks, this hands over another tenant's rows with a valid signature. There is no revocation and no replay defence; a token is good until it expires.

**None of it has run against a real Postgres.** The SQL parses and the tests use a recording fake. `relforcerowsecurity` semantics and GUC case-folding are reasoned about, not observed.
