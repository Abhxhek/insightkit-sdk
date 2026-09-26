# 10 — What you hand to someone else

Four modules landed together: the wire contract, tenant identity, the semantic layer, and the CLI. They look unrelated. They are the same problem four times.

Each one is a place where information leaves our hands and reaches someone else's — a browser, a tenant, a model, a terminal. And at every one of them the interesting question is not *how do I send this* but **what must not go?**

## The browser: a narrowing, not a re-export

The server holds a rich answer. `PlanResult` has the chart, the rows, the attempt history, the token counts, the deny code, the SQL. Publishing that type to the browser is one line.

That one line is a disclosure:

```
E_NOT_SELECT  →  "your probe was detected, and here is how we classified it"
```

That is a free oracle. An attacker sending shaped questions learns the shape of the validator from the error codes coming back. So the wire types are written independently, and a failure crosses as one of three coarse statuses with a human-readable message and nothing else.

There is a subtlety about *where* the check pays off. zod strips unknown keys by default, so a leaked `code` field would be silently discarded when the browser parses. That sounds protective. It isn't — by then the JSON has already crossed the network. The value of **strict** objects is on the **sending** side: a server that validates its own response before serialising turns a leak into a 500 instead of a disclosure. Stripping protects the wrong end.

## The tenant: stop writing the rewriter

One customer's users must not see another's rows. We already inject a row cap into the validated parse tree, so injecting `WHERE tenant_id = $x` the same way looks obvious.

It isn't the same thing at all. A row cap is one clause on a statement we've already shaped. A tenant predicate has to hold on **every relation reference** — inside a subquery, inside a CTE, inside each arm of a `UNION`, behind a view, in a lateral join. Miss one and a customer reads another customer's data, with no error.

Postgres already solved this. Row-Level Security is enforced by the database on every access path, including the ones a rewriter forgets. So:

```
verify JWT → tenant id → SET LOCAL app.tenant_id → Postgres enforces
```

**The library's defaults were not safe, and running it is how we found out.** Three things `jose` does happily:

| | |
|---|---|
| A token with **no `exp`** verifies | a forever-token, valid signature |
| A **5-byte** HS256 secret signs and verifies | brute-forceable offline, no warning |
| `createRemoteJWKSet` accepts **`http://`** | keys over plaintext — verification becomes theatre |

None of these is a bug in `jose`; they're defaults that assume a careful caller. All three are now rejected at config time. If you take one habit from this repo, take that one: *verify library behaviour by running it, not by recalling it.*

And a smaller trap with a sharp edge. A session setting name must be `prefix.name` — the dot is **mandatory** — because an unprefixed name is a built-in Postgres GUC. Without that rule, a scope setting could target `row_security` or `search_path` and **undo the very preamble it travels with**. One regex closes a privilege-escalation path through a config field.

## The model: a glossary is a disclosure surface

Lexical retrieval can't know "monthly recurring revenue" means `mrr_cents`. The semantic layer is where a business word maps to the schema — and where `deleted_at IS NULL` gets to mean "active", which is the difference between a right answer and a plausible wrong one.

An entry can carry a SQL fragment. Is that safe?

It's worth being precise about *why* it is. The fragment is never parsed or executed — the model reads it, writes its own query, and the guard validates **that**. So it is not a trust boundary. What it *is* is a disclosure surface: a fragment naming `users.ssn` puts that name in a prompt even though introspection deliberately withheld the column.

The containment proof is nice, because it avoids a parser entirely:

```
validation:  entry refs        ⊆  schema
lint:        fragment idents   ⊆  entry refs
therefore:   fragment          ⊆  schema
```

Reaching for `guard()` here would have been wrong: it validates *statements*, not expressions, so it would have been a guarantee we couldn't actually make.

The honest cost, and it's a real one: **a wrong entry is worse than no entry.** A definition in a prompt is more authoritative to a model than silence. This layer increases the blast radius of a bad glossary — which is why startup validation isn't politeness, it's the only thing between a typo and confidently wrong answers everywhere.

## The terminal: scrollback is forever

A CLI's output lands in scrollback and CI logs. So `ik doctor` takes its connection URL from an environment variable and there is deliberately **no `--database-url` flag** — argv is visible in `ps` and lands in shell history.

Two details worth stealing. Redaction needs *two* redactors, not one: aggressive scrubbing for error text, and exact-literal scrubbing for anything read back from the database — because a structural pass would rewrite a table legitimately named `token_expires_audit`. And `process.exitCode`, never `process.exit()`, which drops unflushed stdout and truncates piped output.

For `ik doctor` the **exit code is the product**. It's the thing CI reads.

## What building four at once actually taught

They ran in parallel, in separate directories, forbidden from touching shared files. It mostly worked. What it did *not* prevent was this:

The CLI agent wrote a test asserting `"1 finding needs review."` while, concurrently, the identity agent was adding four new checks to `doctor`. Both were correct in isolation. Together the count was wrong.

The fix wasn't to patch the fixture until the number matched again — I tried that first and it just moved the failure. The fix was noticing the test shouldn't have pinned a number at all:

```ts
const reviewed = lines.filter((l) => l.includes('REVIEW')).length
expect(text).toMatch(new RegExp(`${reviewed} findings? needs? review\\.`))
```

Now it asserts the *property* — the printed tally matches what was printed — instead of coupling a CLI test to however many checks `core` happens to ship.

That coupling was always a latent bug. Parallel work didn't create it. It just made it surface in an afternoon instead of in six months.

The other thing worth saying plainly: three of the four agents found real bugs in **my** scaffolding — a dependency rule missing its self-exclusion, a `tsconfig` that a CLI cannot build under, package files never formatted. Fresh eyes on a boundary you wrote are worth a lot, and none of those would have been caught by someone who already knew what the file was supposed to say.

---

Next: `server` and `react` — the two that were deferred because they'd have been guessing at a contract that was being invented next to them.
