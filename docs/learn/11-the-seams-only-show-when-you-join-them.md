# 11 — The seams only show when you join them

Three modules were built at the same time by people who could not talk to each other: the HTTP surface, the React component, and the approved-query store. Each one was correct on its own. Every interesting bug was in the space *between* them.

That is the whole lesson of this chapter, and it generalises well beyond parallel agents.

## Two ADRs, each right, one hole

ADR 0011 says: when the guard refuses SQL for an honest mistake, tell the model why and let it try again. The correction is specific — *"`pg_sleep` is not on the allowlist"* — and that specificity is exactly why repair works.

ADR 0012 says: the wire is a narrowing. A deny code never reaches a browser, because it tells an attacker their probe was detected **and classified**. Failures cross as three coarse statuses. But `unanswerable` carries the model's own prose, deliberately — *"there is no weather data in this schema"* is genuinely useful.

Put them together:

```
turn 1   model → SELECT pg_sleep(10) …
         guard → denied
turn 2   us    → "rejected by the safety check: function pg_sleep is not on the allowlist"
         model → answerable:false, reason:"…pg_sleep is not on the allowlist"
         wire  → unanswerable.message   ← the guard's words, in the browser
```

Nothing branched wrongly. ADR 0011 put the guard's words into the conversation; ADR 0012 let the model's words out. **The hole is the composition.**

Worth noting what the check actually found, because it was not quite what was claimed: the literal `E_FUNCTION_NOT_ALLOWED` is *not* in the repair turn — running `repairTurn` shows only the guard's prose detail. So the leak is real but narrower than "the deny code escapes". It discloses which function tripped the validator and that an allowlist exists. Still a disclosure; not the one first described. Verify the claim, not the conclusion.

The fix has to live in three places because each alone is insufficient:

- **the planner** now sets `sawVerdict` the moment it sends a repair turn — it is the only component that knows the conversation is contaminated
- **the server** discards model prose entirely once any attempt was denied
- **a test** replays the two-turn script and asserts no deny code survives serialisation

## The mismatch that both test suites agreed on

The React package defaulted its endpoints to `endpoint` and `` `${endpoint}/stream` ``. The server routed on the last path segment, listening for `ask` and `subscribe`.

Both suites were green. Neither could see it, because React injects a fake `fetch` and the server is handed a `Request` — **no test on either side asserted the URL**, so the contract lived only in two agents' heads and they disagreed.

```
react  POST  /api/insightkit          server  listens on  …/ask
react  SSE   /api/insightkit/stream   server  listens on  …/subscribe
```

A host following both packages' own documentation would have got a 404 on their first request.

The fix was trivial; the interesting part is that **"all tests pass" was true and meant nothing here**. A contract that no test names is a contract that exists only in prose. There is now a test that posts through `<Insight>` and asserts the literal path.

## When a claimed test is not a test

The store's author wrote that a test covered the classic key-collision case — `('ab','c')` versus `('a','bc')`. There wasn't one. So I wrote it, and *it passed with the length prefix removed*.

That is worth sitting with. The test was not wrong; the property was **over-determined**. The field sequence is fixed and every part ends in `;`, so naive concatenation is already near-injective. The length prefix is defence in depth, not load-bearing — and a test that cannot fail tells you nothing about which of those two it is.

Chasing that turned up a real one the prefix cannot fix:

```js
list(["a\0b"])   →  "syn:3:a\0b;"
list(["a","b"])  →  "syn:3:a\0b;"     identical
```

The join happened *inside* one part, so the outer length could not distinguish them. Reachable through glossary synonyms, which are arbitrary host-authored strings. Fixed at the primitive — each element prefixed — with a test that fails on the old encoder and passes on the new one.

Fourth time this codebase has met this bug class. The first three were fixed at the call site; this one is fixed at the encoder.

## A rule you have watched fail

The server made unscoped reads unreachable four ways, and the fourth is the one worth copying: a test greps every source file and asserts that the list of files calling `runGuardedRead` is **exactly** `['scope.ts']`.

I tried to break it and my first probe did not — I re-exported the function instead of calling it, and the grep looks for the call. The second probe, a genuine second call site, failed the build immediately:

```
expected [ 'scope.ts', 'sneak.ts' ] to deeply equal [ 'scope.ts' ]
```

Two lessons stacked. The rule is real. And *my first attempt to test it was the thing that was wrong* — which is the same mistake as the collision test, one layer up.

## What to take from this

When work is split — across agents, across people, across sprints — the defects do not land inside the pieces. They land in the assumptions each piece made about the others, and those assumptions are invisible to both test suites by construction.

Three habits that actually caught things here:

1. **Name contracts in tests, not in prose.** The endpoint mismatch survived two green suites because no test said the URL out loud.
2. **Break every rule you rely on, and watch it fail.** Three separate controls in this chapter looked correct and two of my probes were wrong before the rules were proven.
3. **Verify the claim, not the conclusion.** "The deny code escapes" was close enough to be actionable and wrong enough to matter.

---

Next: none of this has met a real database or a real model. Eight packages are built, 846 tests pass, and the product's central claim — that it answers correctly — remains entirely unmeasured.
