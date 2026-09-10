import { describe, expect, it } from 'vitest';
import { anthropicProvider } from '../src/anthropic.js';
import type { CompletionRequest } from '../src/types.js';
import { ModelError } from '../src/types.js';

const SCHEMA = {
  type: 'object',
  properties: { sql: { type: 'string' } },
  required: ['sql'],
  additionalProperties: false,
} as const;

const ASK: CompletionRequest = {
  system: 'You write SQL.',
  messages: [{ role: 'user', content: 'how many users' }],
  schema: SCHEMA,
};

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

const message = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: '{"sql":"SELECT count(*) FROM users"}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 42,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 7,
  },
  ...over,
});

/** Drives the real SDK against a fake wire, so these assert the SDK, not a model of it. */
function transport(reply: () => { status?: number; body: unknown }) {
  const sent: Sent[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    sent.push({
      url: String(url),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const r = reply();
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { impl, sent };
}

const provider = (reply: () => { status?: number; body: unknown }, maxRetries = 0) => {
  const t = transport(reply);
  return {
    ...t,
    p: anthropicProvider({
      apiKey: 'sk-ant-secret-key-value-0123456789',
      model: 'claude-opus-5',
      maxRetries,
      fetch: t.impl,
    }),
  };
};

const ok = () => ({ body: message() });

describe('what the adapter sends', () => {
  it('asks for the schema as a structured output format', async () => {
    const { p, sent } = provider(ok);
    await p.complete(ASK);
    expect(sent[0]?.body.output_config).toEqual({
      format: { type: 'json_schema', schema: SCHEMA },
    });
  });

  it('sends the system prompt and the question', async () => {
    const { p, sent } = provider(ok);
    await p.complete(ASK);
    expect(sent[0]?.body.system).toBe('You write SQL.');
    expect(sent[0]?.body.messages).toEqual([{ role: 'user', content: 'how many users' }]);
  });

  it('uses the configured model', async () => {
    const { p, sent } = provider(ok);
    await p.complete(ASK);
    expect(sent[0]?.body.model).toBe('claude-opus-5');
  });

  it('passes effort only when asked for', async () => {
    const effortOf = (s: Sent | undefined): string | undefined =>
      (s?.body.output_config as { effort?: string } | undefined)?.effort;

    const a = provider(ok);
    await a.p.complete({ ...ASK, effort: 'low' });
    expect(effortOf(a.sent[0])).toBe('low');

    const b = provider(ok);
    await b.p.complete(ASK);
    expect(effortOf(b.sent[0])).toBeUndefined();
  });

  it('always bounds the output', async () => {
    const { p, sent } = provider(ok);
    await p.complete(ASK);
    expect(sent[0]?.body.max_tokens).toBeGreaterThan(0);
  });

  it('sends the key as a header and nowhere else', async () => {
    const { p, sent } = provider(ok);
    await p.complete(ASK);
    expect(sent[0]?.headers['x-api-key']).toBe('sk-ant-secret-key-value-0123456789');
    expect(JSON.stringify(sent[0]?.body)).not.toContain('sk-ant');
  });
});

describe('what the adapter makes of the reply', () => {
  it('returns the object the model produced', async () => {
    // The adapter does its own JSON step, so this also pins that a well-formed reply
    // still arrives as an object rather than a string.
    const { p } = provider(ok);
    const done = await p.complete(ASK);
    expect(done.output).toEqual({ sql: 'SELECT count(*) FROM users' });
  });

  it('reports token usage, cache included', async () => {
    const { p } = provider(ok);
    expect((await p.complete(ASK)).usage).toEqual({
      inputTokens: 1200,
      outputTokens: 42,
      cacheReadTokens: 900,
      cacheWriteTokens: 7,
    });
  });

  it('treats absent cache counters as zero rather than undefined', async () => {
    const { p } = provider(() => ({
      body: message({ usage: { input_tokens: 5, output_tokens: 1 } }),
    }));
    const usage = (await p.complete(ASK)).usage;
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(0);
  });

  it('reports which model actually answered', async () => {
    const { p } = provider(ok);
    expect((await p.complete(ASK)).model).toBe('claude-opus-5');
  });
});

describe('replies that must not be mistaken for answers', () => {
  it('refuses a truncated response instead of returning a fragment', async () => {
    const { p } = provider(() => ({
      body: message({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '{"sql":"SELECT sum(amount) FROM orders WHERE created_at >' }],
      }),
    }));
    const err = await p.complete(ASK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('truncated');
    expect((err as ModelError).retryable).toBe(false);
  });

  it('surfaces a refusal with its category rather than an empty answer', async () => {
    const { p } = provider(() => ({
      body: message({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
        content: [],
      }),
    }));
    const err = await p.complete(ASK).catch((e: unknown) => e);
    expect((err as ModelError).kind).toBe('refused');
    expect((err as ModelError).message).toContain('cyber');
  });

  it('copes with a refusal that names no category', async () => {
    const { p } = provider(() => ({
      body: message({ stop_reason: 'refusal', stop_details: null, content: [] }),
    }));
    expect(((await p.complete(ASK).catch((e: unknown) => e)) as ModelError).message).toContain('unspecified');
  });

  it('rejects a reply that is not the object we asked for', async () => {
    const { p } = provider(() => ({
      body: message({ content: [{ type: 'text', text: 'Sure! Here is your SQL:' }] }),
    }));
    expect(((await p.complete(ASK).catch((e: unknown) => e)) as ModelError).kind).toBe('no_output');
  });
});

describe('failures are typed so a caller can tell retry from give up', () => {
  const failing = (
    status: number,
    body: unknown = { type: 'error', error: { type: 'x', message: 'boom' } },
  ) => provider(() => ({ status, body }));

  it('marks an auth failure as final', async () => {
    const err = (await failing(401)
      .p.complete(ASK)
      .catch((e: unknown) => e)) as ModelError;
    expect(err.kind).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('marks rate limiting as worth retrying', async () => {
    const err = (await failing(429)
      .p.complete(ASK)
      .catch((e: unknown) => e)) as ModelError;
    expect(err.kind).toBe('rate_limited');
    expect(err.retryable).toBe(true);
  });

  it('marks a server fault as worth retrying', async () => {
    const err = (await failing(503)
      .p.complete(ASK)
      .catch((e: unknown) => e)) as ModelError;
    expect(err.kind).toBe('transport');
    expect(err.retryable).toBe(true);
  });

  it('marks a malformed request as final', async () => {
    const err = (await failing(400)
      .p.complete(ASK)
      .catch((e: unknown) => e)) as ModelError;
    expect(err.kind).toBe('bad_request');
    expect(err.retryable).toBe(false);
  });

  it('never lets the key reach the error a caller sees', async () => {
    const leaky = failing(400, {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'bad key sk-ant-secret-key-value-0123456789' },
    });
    const err = (await leaky.p.complete(ASK).catch((e: unknown) => e)) as ModelError;
    expect(err.message).not.toContain('sk-ant-secret-key-value-0123456789');
    expect(err.message).toContain('[redacted]');
  });
});

describe('refusing to be constructed badly', () => {
  const build = (o: Record<string, unknown>) => anthropicProvider({ apiKey: 'k', model: 'm', ...o } as never);

  it('says plainly that the key is the caller to supply', () => {
    expect(() => build({ apiKey: '' })).toThrow(/never supplies one/);
    expect(() => build({ apiKey: '   ' })).toThrow(/API key is required/);
  });

  it('requires a model id', () => {
    expect(() => build({ model: '' })).toThrow(/model id is required/);
  });
});
