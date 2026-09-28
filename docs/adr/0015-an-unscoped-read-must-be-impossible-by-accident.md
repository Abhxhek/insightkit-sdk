# ADR 0015 — An unscoped read must be impossible by accident

Status: accepted, 2026-09-29

## Context

ADR 0013 ended with the largest known fail-open in the project:

> `runGuardedRead(source, query)` with no scope runs unscoped. It is not fixable in `core` alone — a single-tenant install legitimately has no scope — so it belongs in `server`, which is where a request becomes a tenant.

`packages/server` is that place. It is also the first component a host configures rather than calls, which changes what "safe by default" has to mean: the dangerous option must be *unreachable by omission*.

## Decision

**Four layers, mirroring `approve` / `isGuardedQuery`.**

1. **`tenancy` is a required discriminated union with no default.** Omitting it is a type error, and construction throws for a JavaScript host. There is no "leave it out and get the permissive thing" path.
2. **The single-tenant arm demands a sentence, not a boolean.** `{ mode: 'single', acknowledge: 'every user of this app may read every row' }`, typed so only that exact literal compiles. A boolean reads as a shrug in review; that sentence greps across a customer codebase and says what it means.
3. **A runtime brand.** `ReadScope` carries a real symbol with exactly two producers, one of which re-checks the acknowledgement rather than trusting config — the same validate-twice shape as `assertSettingName`. A plain object fails to compile and a cast fails at runtime.
4. **One call site.** `runScopedRead` takes a non-optional `ReadScope` and is the only function in the package that calls `runGuardedRead`. A test greps every source file and asserts the list of files containing that call is exactly `['scope.ts']`, so a future handler that reaches around it fails CI. **Verified by adding a second call site and watching it fail**, not assumed.

**Every planner outcome answers HTTP 200** — ok, unanswerable, refused, error. Returning 422 for refused and 502 for a model failure would rebuild the exact oracle ADR 0012 closed: an attacker learns their probe was classified from the status line without reading the body. Non-200 is reserved for whether the *request* was admissible — 400/413/415 body, 401/403 identity, 405 method, 429 throttle, 503 capacity, and 500 only when our own outgoing validation fails.

**Security events change throttling, not status.** Attack-shaped denials accumulate strikes against an identity and eventually earn a cooldown; answering 403 on detection would be the same oracle by another route. The strike is recorded *before* the host's callback runs, so a throwing logger cannot lose it.

**Subscribe re-resolves the scope from the bearer token on every tick**, and the stream store keeps only the identity, never the settings. Storing ask-time settings would let a revoked token keep streaming under a stale scope.

**Unknown, expired and another identity's stream token answer identically** — a single `closed: expired` frame. Distinguishing them would tell a token holder which case they hit.

## The leak this surfaced, which neither ADR could see alone

ADR 0011 feeds the guard's verdict back to the model so it can repair an honest mistake. ADR 0012 makes `unanswerable` the one failure whose message is the model's own prose.

Put them together and the guard's words reach the browser with no branch doing anything wrong:

```
turn 1  model → SELECT pg_sleep(10) …
        guard → E_FUNCTION_NOT_ALLOWED
turn 2  us    → "rejected by the safety check: function pg_sleep is not on the allowlist"
        model → answerable: false, reason: "…pg_sleep is not on the allowlist"
        wire  → unanswerable.message
```

The literal deny code is not in the repair turn — that was checked by running it — but the guard's *detail* is, and that discloses which function tripped the validator and that an allowlist exists.

Two independently correct designs, one emergent disclosure. Fixed in three places, because each alone is insufficient:

- **`core`**: a failed `PlanResult` now carries `sawVerdict`, set the moment a repair turn is sent. The planner is the only component that knows the conversation was contaminated.
- **`server`**: model prose is discarded for a generic message whenever any attempt was denied, and a deny-code pattern is scrubbed from anything that does cross.
- **a test** reproducing the two-turn script and asserting the serialised JSON contains none of the deny codes.

## Consequences

Every host that uses `core` directly rather than through `server` must re-invent all of this. `ScopedReadOptions.scope` being optional is still the underlying fail-open; this package closes it for its own callers only. The eval corpus case `tenant-scoping` therefore stays **asserted open** — it is closed for the reader path *as reached through `server`*, not for `runGuardedRead` itself.

Limits are per-process, so N instances means N times the limits. That is a cost floor, not a security control, and the code says so.

A Web `Request` cannot see the peer address, so an unauthenticated flood is bounded only by the body cap and signature verification. A host must supply an identity function fed from a trusted proxy header.

`createScopeResolver` drops the token's expiry, so a stream cannot be closed when the JWT behind it expires; a maximum duration is a blunt substitute. `TenantScope` should carry `expiresAt`.
