# 09 — The part that guesses

Everything before this chapter was preparation or protection. The guard decides whether SQL is safe. Introspection says which tables exist. Retrieval picks the relevant ones. None of them answer a question.

The planner does. It is also the first component whose quality is a *measurement* rather than a proof — and we cannot take that measurement yet.

## The shape of it

```
question ──▶ retrieval ──▶ prompt ──▶ model ──▶ guard ──▶ sealed txn ──▶ rows
                                        │         │
                                        └─repair──┘   (only sometimes)
```

The model returns two things, because a chart needs both:

```json
{ "answerable": true,
  "sql": "SELECT signup_method AS method, count(*) AS signups FROM users GROUP BY 1",
  "chart_kind": "bar", "chart_x": "method", "chart_y": ["signups"] }
```

Note `answerable`. Ask a SaaS database *"what's the weather in Jaipur"* and without that field the model **will** invent something plausible. `SELECT * FROM users` returns rows, the chart draws, and the user believes it. A refusal is a feature, not a failure.

There's a subtlety worth naming: `answerable: true` with no SQL is *not* a refusal. That's the model contradicting itself, and reporting it as "the schema can't answer this" would tell the user something untrue. It's an invalid plan. Different thing, different message.

## Repair, and why "should we retry?" is the wrong question

When the guard says no, should we tell the model why and let it try again?

The instinct is that retrying near a security boundary sounds dangerous. **It isn't.** Every attempt ends at the guard — attempt five gets exactly the same scrutiny as attempt one. There is no path where retrying admits something that would otherwise be refused.

So the safety objection evaporates. What replaces it is better:

> Repairing an attack hands the attacker an **automated loop against your validator**, billed to your customer.

Two attempts is two probes of where the boundary sits. Ten would be a free fuzzer with a helpful error message after each shot. That's an information leak about your defences, and we'd be running it *for* them.

Which means the question isn't "retry or not". It's **which denials deserve a retry**.

## Two kinds of "no"

The guard refuses for two unrelated reasons, and only one is worth another attempt.

**A mistake:**

```
E_FUNCTION_NOT_ALLOWED: pg_sleep
E_PARSE: syntax error at or near "FRM"
E_LIMIT_NOT_STATIC
```

That's our allowlist being narrow, or the model slipping. Telling it *"that function isn't available, use another"* is a correction models handle well. Worth one more shot.

**Not a mistake:**

```
E_NOT_SELECT: DELETE FROM users
E_MULTI_STATEMENT: SELECT 1; DROP TABLE users
E_NUL_BYTE
```

A model asked to count users does not *accidentally* reach for `DELETE`. Stacked statements are injection's actual signature. Nothing legitimate puts a NUL in SQL. These stop immediately — no second call, no second probe.

And they're reported differently, which matters more than it sounds.

## A denial is not always an error

An attack-shaped denial isn't a failed query. It's someone testing your boundary. If we returned it as a generic error it would vanish into the same bucket as a typo.

So it comes back through a callback:

```ts
planQuery(deps, question, selection, {
  onSecurityEvent: (e) => log.warn({ code: e.code, sql: e.sql, question: e.question })
})
```

Now the developer can alert on it, or rate-limit a user producing three `E_NOT_SELECT`s in a minute. That's information they can't get any other way.

One detail: the callback is wrapped in a `try/catch`. **A host's logger must not be able to fail the request it's reporting on.** If their log aggregator is down, the query still answers.

## Where the honesty runs out

`E_FIELD_NOT_ALLOWED` fires for benign unsupported clauses — *and* for `SELECT * INTO exfil FROM users`, which is exfiltration.

The code alone cannot tell them apart. Right now it's treated as repairable and raises no security event, which means a real exfiltration attempt gets one polite retry and no alert.

The proper fix is a finer deny code in `sql-guard`. Until then this classification is **a heuristic, not a proof**, and that's worth writing down rather than discovering later. The guard blocks both either way — what's imperfect is our reading of intent, not the defence.

## The rule that had never fired

Adding the planner turned up a contradiction. The architecture table said `core` may import `llm`. The enforced dependency rule said it may not. Both had been sitting there for weeks, disagreeing, because nothing had ever tried.

The tempting move is to edit the rule — my code needs the import, the doc says it's fine, one line and the build is green.

Don't. Weakening an enforced constraint so new code fits is precisely the reflex this project exists to resist. And `core` already had the right pattern: it declares `SqlClient` structurally rather than importing `pg`, so it's testable without a database. `ModelProvider` gets the same treatment:

```ts
export interface ModelProvider {
  readonly id: string
  readonly model: string
  complete(request: ModelRequest): Promise<ModelCompletion>
}
```

`core` now takes on **no dependency** to reach a model. `@insightkit/llm` merely happens to satisfy the shape — and a test asserts it still does, so the seam can't drift in silence. Provider errors are read by duck-typing `kind` rather than `instanceof`, for the same reason.

The doc was the thing that was wrong, and it's fixed.

## What this is worth so far

Run it end to end and the plumbing works. A denied `pg_sleep` gets corrected on the second attempt, the guard re-emits the SQL, the row cap lands:

```
attempts : 1:denied(E_FUNCTION_NOT_ALLOWED) → 2:approved
```

But notice what that proves: **the machinery works.** It says nothing about whether the SQL answers the question correctly, because the model in that run was a fake returning a scripted answer.

Every attempt is recorded — the SQL, the outcome, the deny code, the tokens — so when the eval corpus finally runs, a bad score is *attributable*. You'll know whether repair earned its cost, whether the model refuses when it should, and which questions it gets wrong.

That's the whole point of having built the eval first. It just still has nothing to run against.

---

Next: wiring the corpus to a real database and a real model, and finding out for the first time whether any of this actually answers a question correctly.
