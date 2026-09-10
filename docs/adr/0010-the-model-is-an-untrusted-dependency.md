# ADR 0010 — The model is a dependency that lies, refuses, and stops halfway

Status: accepted, 2026-09-10

## Context

`packages/llm` is the first code in this project that leaves the machine. It is also the first component whose output is not merely *untrusted* in the security sense but *unreliable* in the ordinary sense: the same request can succeed, be declined, or come back truncated, and two of those three arrive as HTTP 200.

The decision that shapes everything else is who supplies the credential.

## Decision

**The developer supplies the provider, the model and the key. InsightKit never ships one.**

The alternative considered was a "free default" so the SDK works with no configuration. It does not survive contact with the details. A free *tier* still needs a key, so either we embed ours — public the moment the repository is pushed, scraped within hours, and billed to us until it is revoked — or the user supplies one anyway and the default saved nothing.

There is a second reason, independent of the first. This is an analytics product, and a weak default model does not fail loudly: it returns a plausible *wrong number*. A missing key is a thirty-second fix; a revenue figure that was quietly wrong destroys trust in the product permanently. We also have no evidence yet about which models are good enough at this — that is what the eval corpus is for, and it has not run. Choosing a default today would be guessing, and guessing in the direction that costs the most to be wrong about.

So configuration is required, and the error when it is missing does the teaching instead.

**`llm` knows nothing about SQL.** It sends messages and returns an object. The planner, which knows about schemas and produces SQL, lives in `core`. This is already the architecture's rule — `llm` may not import `sql-guard` — and the split is the point: the code that talks to an untrusted model does not sit beside the code that decides what is trusted. That rule was verified to fire, not assumed.

**The interface promises a shape; each adapter delivers it however its provider does best.** Anthropic gets `output_config.format` with a JSON Schema. A provider without structured outputs would use tool calling, or JSON mode plus validation. The planner does not learn which.

**The result is still validated by the caller.** A provider's schema guarantee is not a guarantee we made, and this path ends in SQL. Same instinct as the guard's deparse round-trip.

**Three response shapes are errors, not answers.**

| `stop_reason` | Why it cannot be returned |
|---|---|
| `max_tokens` | The answer is a fragment. A cut-off statement can still be *valid syntax* — `SELECT sum(amount) FROM orders WHERE created_at >` parses far enough to look real. |
| `refusal` | HTTP 200, no content. Treated as a normal response it reads as an empty answer. |
| unparseable text | The model prosed instead of answering. |

**Failures are typed, with `retryable` on them.** A caller needs to distinguish "wait and try again" (rate limit, timeout, 5xx) from "this will never work" (auth, bad request, truncation). Retrying a truncation produces another truncation.

**Credentials never reach anything we surface.** Adapters translate provider errors into our own type carrying only a message and a status — never the provider's error object, which holds request configuration. On top of that, every message we emit passes through a redaction pass for key-shaped strings. Belt and braces, because the failure mode is somebody's key in a log aggregator.

**Usage is reported on every call.** The eval harness already has a spend cap with nothing to feed it.

**The provider SDK is an optional peer dependency**, exactly as `pg` is for `core`. Install `@insightkit/llm`, pull in only the provider you actually use.

## Consequences

Nothing works until the developer configures a provider. That is the intended trade.

Every adapter is another API surface to keep current. The interface is narrow — one method — specifically to keep that cost near the cost of the HTTP call itself.

The customer's **schema** travels to a third party in the prompt. Table names, column names, comments. For customers who cannot allow that, a local-model adapter is not a nicety but the difference between adopting and not. It is also, incidentally, the honest answer to "can it be free": local models cost nothing and need no key.

Once the planner exists and the corpus can run, model choice stops being an opinion and becomes a table of accuracy and cost per provider. That is worth publishing, and it is the argument that makes the multi-adapter work pay for itself.

## The bug this ordering already caught

The first version called the SDK's `messages.parse()` helper, which parses the response and *then* returns it. On a truncated reply the JSON is invalid, so the helper threw before `stop_reason` could be read — and the thrown error was a generic transport failure, which our own classification marks **retryable**. A truncated answer would have been retried until it truncated again, with nothing in the error to say why.

The adapter now calls `messages.create()` and does the JSON step itself, after the stop-reason checks. Ordering was worth more than the one `JSON.parse` the helper saved. A test pins it.

## The second adapter, and what it was for

Anthropic and OpenAI are both implemented; Grok and a local-model adapter are deliberately not.

Two providers rather than one is the point. An interface with a single implementation is indistinguishable from that implementation, and would have drifted Anthropic-shaped without anyone noticing. A **conformance suite** now runs the same assertions against both — same contract for truncation, refusal, unparseable output, failure classification, credential redaction and construction errors — so a difference between providers has to be reconciled in the adapter rather than leaking into the planner.

It also mapped where the providers genuinely differ:

| | Anthropic | OpenAI |
|---|---|---|
| Structured output | `output_config.format` | `response_format.json_schema` with `strict` |
| Truncation | `stop_reason: "max_tokens"` | `finish_reason: "length"` |
| Refusal | `stop_reason: "refusal"` + category | `message.refusal` string, or `finish_reason: "content_filter"` |
| Cache accounting | reads *and* writes reported | reads only; writes are not reported |
| System prompt | a top-level field | the first message |

Only the last two rows reach the interface at all, and both are absorbed: an unreported cache-write count is zero, and a system prompt is a field on the request either way.

Both SDKs also share the ordering hazard described above — each ships a `parse` helper that raises before the stop reason can be read — so both adapters call `create` and do the JSON step themselves.

**Peer ranges claim only what was tested.** The first version declared `@anthropic-ai/sdk >=0.70.0` while being written against 0.124: `output_config.format` does not exist in 0.70, so the range promised compatibility that could not hold. Ranges are now floored at the version actually exercised.

## Alternatives rejected

**Ship a free default model.** Covered above: no such thing as a keyless free tier, and a weak default fails silently in the worst possible way for an analytics product.

**Raw `fetch` instead of the provider SDK.** Zero dependencies, and appealing given how much this project cares about its dependency list. Rejected because it means reimplementing retry, backoff and error classification, and because the SDK is the documented surface — hand-rolled HTTP drifts from it silently.

**Let `llm` own the prompt.** Would put schema knowledge next to the model client, which is the boundary the architecture exists to keep.
