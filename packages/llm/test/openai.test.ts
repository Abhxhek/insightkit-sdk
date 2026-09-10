import { describe, expect, it } from 'vitest';
import { openaiProvider } from '../src/openai.js';
import type { CompletionRequest, ModelError } from '../src/types.js';
import type { Reply, Sent } from './transport.js';
import { SCHEMA, SECRET, transport } from './transport.js';

const ASK: CompletionRequest = {
  system: 'You write SQL.',
  messages: [{ role: 'user', content: 'how many users' }],
  schema: SCHEMA,
};

export const completion = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-5',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '{"sql":"SELECT count(*) FROM users"}', refusal: null },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 42,
    total_tokens: 1242,
    prompt_tokens_details: { cached_tokens: 900 },
  },
  ...over,
});

const choice = (message: Record<string, unknown>, finish: string): Record<string, unknown> =>
  completion({ choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }] });

const provider = (reply: () => Reply, extra: Record<string, unknown> = {}) => {
  const t = transport(reply);
  return {
    ...t,
    p: openaiProvider({ apiKey: SECRET, model: 'gpt-5', maxRetries: 0, fetch: t.impl, ...extra }),
  };
};

const ok = (): Reply => ({ body: completion() });

describe('what the OpenAI adapter sends', () => {
  const formatOf = (s: Sent | undefined) =>
    s?.body.response_format as { type: string; json_schema: Record<string, unknown> } | undefined;

  it('asks for the schema as a strict structured output', async () => {
    const { p, sent } = provider(ok);
    await p.complete(ASK);
    const format = formatOf(sent[0]);
    expect(format?.type).toBe('json_schema');
    expect(format?.json_schema.schema).toEqual(SCHEMA);
    expect(format?.json_schema.strict).toBe(true);
  });

  it('can relax strictness for a compatible endpoint that lacks it', async () => {
    const { p, sent } = provider(ok, { strictSchema: false });
    await p.complete(ASK);
    expect(formatOf(sent[0])?.json_schema.strict).toBe(false);
  });

  it('carries the system prompt as a system message', async () => {
    const { p, sent } = provider(ok);
    await p.complete(ASK);
    expect(sent[0]?.body.messages).toEqual([
      { role: 'system', content: 'You write SQL.' },
      { role: 'user', content: 'how many users' },
    ]);
  });

  it('uses the configured model and bounds the output', async () => {
    const { p, sent } = provider(ok);
    await p.complete(ASK);
    expect(sent[0]?.body.model).toBe('gpt-5');
    expect(sent[0]?.body.max_completion_tokens).toBeGreaterThan(0);
  });

  it('sends the key as a header and nowhere else', async () => {
    const { p, sent } = provider(ok);
    await p.complete(ASK);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(sent[0]?.body)).not.toContain('sk-ant');
  });

  it('honours a base URL so a compatible endpoint can be used', async () => {
    const { p, sent } = provider(ok, { baseURL: 'https://example.test/v1' });
    await p.complete(ASK);
    expect(sent[0]?.url.startsWith('https://example.test/v1')).toBe(true);
  });
});

describe('what the OpenAI adapter makes of the reply', () => {
  it('maps usage, including the cached prompt tokens', async () => {
    const { p } = provider(ok);
    expect((await p.complete(ASK)).usage).toEqual({
      inputTokens: 1200,
      outputTokens: 42,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
  });

  it('reports the model that actually answered', async () => {
    const { p } = provider(() => ({ body: completion({ model: 'gpt-5-2026-01-01' }) }));
    expect((await p.complete(ASK)).model).toBe('gpt-5-2026-01-01');
  });

  it('treats a refusal string as a refusal, not an empty answer', async () => {
    const { p } = provider(() => ({
      body: choice({ content: null, refusal: 'I cannot help with that' }, 'stop'),
    }));
    const err = (await p.complete(ASK).catch((e: unknown) => e)) as ModelError;
    expect(err.kind).toBe('refused');
    expect(err.message).toContain('I cannot help with that');
  });

  it('treats a content filter stop as a refusal', async () => {
    const { p } = provider(() => ({ body: choice({ content: null, refusal: null }, 'content_filter') }));
    expect(((await p.complete(ASK).catch((e: unknown) => e)) as ModelError).kind).toBe('refused');
  });

  it('rejects a response with no choices at all', async () => {
    const { p } = provider(() => ({ body: completion({ choices: [] }) }));
    expect(((await p.complete(ASK).catch((e: unknown) => e)) as ModelError).kind).toBe('no_output');
  });
});
