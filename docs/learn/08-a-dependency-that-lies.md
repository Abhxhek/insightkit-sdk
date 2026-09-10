# 08 — A dependency that lies

Every dependency so far has been deterministic. Give `sql-guard` the same string twice and you get the same verdict twice. Give `selectTables` the same question and you get the same tables.

`packages/llm` is the first one that doesn't work like that. Same request, three possible outcomes — and two of them arrive as HTTP 200.

## Who pays

The first decision isn't technical. It's: **who supplies the API key?**

The appealing answer is "we do, with a free model, so the SDK works the moment you install it". It does not survive five minutes of thought.

A free *tier* still needs a key. So either we embed ours — which is public the instant the repo is pushed, scraped within hours, and billed to us until it's revoked — or the user supplies one anyway and the "default" saved nobody anything. There is no third option. **Free-tier is not keyless.**

The second reason is worse, and it's specific to this product. A weak model doesn't fail loudly. It returns a *plausible wrong number*. A missing API key is a thirty-second fix; a revenue figure that was quietly wrong destroys trust in the product permanently.

And we have no evidence yet about which models are good enough — that's what the eval corpus is for, and it hasn't run. Picking a default today would be guessing, in the direction that costs the most to be wrong about.

So: the developer picks provider, model and key. The error when they haven't does the teaching.

## Keeping the model away from the trust decision

`llm` sends messages and returns an object. It has never heard of SQL, schemas, or tables. The planner — which knows all three — lives in `core`.

That's not tidiness. It's the same boundary the whole architecture is built on: *the code that talks to an untrusted model does not sit next to the code that decides what is trusted.* Model output crosses that gap as a plain string and comes back as a verdict.

There's a rule enforcing it. When adding this package I tested that the rule actually fires — and learned something: it didn't, at first, because `@insightkit/sql-guard` wasn't a dependency of `llm`, so the import was unresolvable and dependency-cruiser had nothing to classify. Adding the dependency and re-testing made it fire correctly. A rule you've never seen fail is a rule you don't know you have.

## Three replies that are not answers

This is the part that actually bites.

| `stop_reason` | What it looks like | Why it's an error |
|---|---|---|
| `max_tokens` | A response | The answer is a **fragment** |
| `refusal` | HTTP 200, empty content | Reads as an empty answer |
| unparseable | A response | The model prosed instead of answering |

The truncation case deserves attention:

```sql
SELECT sum(amount) FROM orders WHERE created_at >
```

That's what a cut-off answer looks like. It's not obviously broken — it parses a long way before it fails, and a slightly different truncation point produces something that parses *completely* and means something entirely different from what was asked. In an analytics product that's a wrong number with no error attached.

The refusal case is real too. Ask "show me every user's password hash" and a safety classifier may decline. HTTP 200. `stop_reason: "refusal"`. No content. Handle it as a normal response and your user sees an empty chart with no explanation.

## The bug that ordering caught

The first version used the SDK's `messages.parse()` helper — it makes the request and parses the JSON for you. Convenient.

On a truncated reply, the JSON is invalid. So the helper threw **before** `stop_reason` could be read. And the error it threw was a generic transport failure, which our own classification marks **`retryable: true`**.

Follow that through: a truncated answer gets retried. It truncates again. Retried again. The caller never learns why, because the reason was discarded by a parse that ran too early.

The fix is to call `messages.create()` and do the JSON step ourselves, *after* checking `stop_reason`:

```ts
if (message.stop_reason === 'refusal') throw new ModelError('refused', ...)
if (message.stop_reason === 'max_tokens') throw new ModelError('truncated', ...)
// only now look at the content
```

Correct ordering was worth more than the one `JSON.parse` the helper saved. A test pins it, and that test failed before the fix — which is the only reason to trust it.

The general lesson: **a convenience helper decides an ordering for you.** Usually that's fine. When one of the orderings is a security or correctness property, take it back.

## Retryable is a property of the failure

```ts
export type ModelErrorKind =
  | 'truncated' | 'refused' | 'no_output'      // never retry
  | 'rate_limited' | 'timeout' | 'transport'    // retry
  | 'auth' | 'bad_request'                      // never retry
```

A caller needs to tell "wait and try again" from "this will never work". Without that distinction you either retry things that can't succeed, or give up on things that would have.

## Somebody else's key

This package handles a credential that isn't ours, in a library that runs inside someone else's product. Two rules:

**Never attach the provider's error object.** It carries request configuration. We translate into our own error type carrying a message and a status, and nothing else.

**Redact anything we do emit.** A last line of defence in front of every message:

```ts
const KEY_LIKE = /\b(?:sk|pk|api|key|token|bearer)[-_][A-Za-z0-9_-]{12,}/gi
```

Note the shape of that pattern — a literal alternation, then a *single* character class. No nested quantifier, so it can't backtrack. Chapter 07's CodeQL finding was still fresh; writing a regex that scans untrusted error text without thinking about that would have been careless twice in a row.

## What's still missing

The customer's **schema** goes into the prompt — table names, column names, comments. It leaves their infrastructure and reaches a third party.

For plenty of companies that's fine. For health, finance and government customers it's contractually impossible, which makes a local-model adapter not a nicety but the difference between adopting and not. It's also, incidentally, the honest answer to "can it be free": a local model costs nothing and needs no key.

And once the planner exists, model choice stops being an opinion. The corpus can run against each provider and produce a table of accuracy and cost — which is the thing a developer actually wants to know and almost nobody publishes.

---

Next: the planner. A question, a schema, and a model — producing SQL that then has to get past the guard.
