# insightics-llm

Model provider adapters. You hand it a system prompt, a conversation and a JSON Schema; it hands back an object, a token count, and typed failures. It knows nothing about SQL.

## The boundary

`llm` may not import `insightics-sql-guard` or `insightics-core` — `llm-never-touches-guard` in [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs) — and may not import a database driver, which `core-is-the-only-database-package` forbids for every package but `core`.

The rule is about blast radius. This is the component that leaves the machine and the first one whose output is unreliable rather than merely untrusted, so it does not sit next to the code that decides what is trusted. Model output crosses that gap as a plain string and comes back as a verdict somebody else produced.

The rule runs the other way too: `core-never-reaches-the-browser` stops `core` importing `llm`. `core` declares the provider shape structurally, so the planner costs no dependency on this package and any client satisfying the shape works.

`pnpm --filter insightics-llm list --prod --depth Infinity` reports **nothing** — zero production dependencies. Both SDKs are optional peers.

## Install

```bash
pnpm add insightics-llm

# then whichever provider you actually use
pnpm add @anthropic-ai/sdk   # >=0.124.0
pnpm add openai              # >=7.0.0
```

Both peer dependencies are marked optional, and each adapter lives behind its own subpath (`insightics-llm/anthropic`, `insightics-llm/openai`), so importing one never pulls in the other. The floors are the versions actually exercised, not the oldest plausible ones. ADR 0010 records why: an earlier range claimed `>=0.70.0` while the code was written against `output_config.format`, which 0.70 does not have.

## Usage

```ts
import { anthropicProvider } from 'insightics-llm/anthropic';
import { ModelError } from 'insightics-llm';

const provider = anthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-opus-5',
});

try {
  const completion = await provider.complete({
    system: 'Return a plan as JSON.',
    messages: [{ role: 'user', content: 'how many users are there?' }],
    schema: {
      type: 'object',
      properties: { answerable: { type: 'boolean' }, sql: { type: 'string' } },
      required: ['answerable', 'sql'],
      additionalProperties: false,
    },
  });

  completion.output; // unknown — validate it yourself
  completion.usage;  // { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
  completion.model;  // the id the provider reports, not the one you asked for
} catch (err) {
  if (err instanceof ModelError) {
    err.kind;      // 'truncated' | 'refused' | 'no_output' | 'rate_limited'
                   // | 'timeout' | 'auth' | 'bad_request' | 'transport'
    err.retryable; // false for 'truncated' — a second try truncates too
    err.message;   // 'the response reached the 4096 token limit, so it is incomplete'
  }
}
```

`openaiProvider` from `insightics-llm/openai` takes the same options plus `strictSchema`, and satisfies the same `Provider` interface. Both accept a `fetch` override, which is how the tests drive the real SDKs against a fake wire.

## What defines it

**No default provider, model or key.** A free tier still needs a key, so a bundled default means either our key in a public repo or nothing saved at all — and a weak default model answers an analytics question with a plausible *wrong number* rather than an error, which is unrecoverable. Configuration is required, and the missing-config error teaches: `an API key is required. Insightics never supplies one: pass the key for the provider you chose.` See [ADR 0010 — The model is a dependency that lies, refuses, and stops halfway](../../docs/adr/0010-the-model-is-an-untrusted-dependency.md).

**Two adapters, so the interface is an interface.** A single implementation is indistinguishable from the thing it implements. A conformance suite in [`test/conformance.test.ts`](./test/conformance.test.ts) runs the same ten assertions against both adapters — naming, usage counters, truncation, refusal, unparseable prose, failure classification, key handling, required config — so a provider difference is reconciled inside the adapter rather than leaking upward.

**Three replies are errors, not answers.** `max_tokens` becomes `truncated` (a cut-off SQL statement can still be valid syntax, which is the dangerous case), `refusal` becomes `refused` (HTTP 200 with no content, which otherwise reads as an empty answer), and text that will not parse becomes `no_output`. `stop_reason` is checked *before* the body is read: the SDK's `messages.parse()` helper throws on invalid JSON first, which turned a truncation into a retryable transport error, so this calls `messages.create()` and does the JSON step itself.

**Every failure is a `ModelError` carrying `kind` and `retryable`.** Only `rate_limited`, `timeout` and `transport` retry by default; retrying a truncation produces another truncation. The provider's own error object is never attached or re-thrown as a cause, because it carries request configuration — only the message and the status cross over, and `ModelError`'s constructor passes the message through `redact()` on the way.

## What it does not do

- **It does not know what SQL is.** No schemas, no planning, no repair loop, no guard. Those are in `insightics-core`; this package sends messages and returns an object.
- **It does not validate the output.** `Completion.output` is `unknown` on purpose. A provider's structured-output guarantee is not a guarantee this package made, and the caller validates regardless of which mechanism the adapter used to ask for it.
- **It does not retry, rate-limit or cap spend.** The SDK's own `maxRetries` (default 2) is the only retrying here. `usage` is reported on every call so something above can meter it.
- **It does not stream**, and has no embeddings, tool-use or vision surface.
- **`redact()` is a last line, not a sanitiser.** It matches one pattern: `sk`, `pk`, `api`, `key`, `token` or `bearer`, a `-` or `_`, then 12 or more word characters. A credential in any other shape passes through untouched.
- **It has never talked to a real model.** Its tests drive the genuine Anthropic and OpenAI SDKs against a fake `fetch` that returns response bodies written by hand in the tests (`npx vitest run packages/llm` from the repo root). That proves what we send and how we classify what comes back, not how a provider behaves.
