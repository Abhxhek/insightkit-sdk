import { describe, expect, it } from 'vitest';
import { anthropicProvider } from '../src/anthropic.js';
import { openaiProvider } from '../src/openai.js';
import type { CompletionRequest, Provider } from '../src/types.js';
import { ModelError } from '../src/types.js';
import type { Reply } from './transport.js';
import { SCHEMA, SECRET, transport } from './transport.js';

const ASK: CompletionRequest = {
  system: 'You write SQL.',
  messages: [{ role: 'user', content: 'how many users' }],
  schema: SCHEMA,
};

const ANSWER = '{"sql":"SELECT count(*) FROM users"}';

interface Adapter {
  readonly name: string;
  readonly build: (fetch: typeof globalThis.fetch) => Provider;
  readonly bad: (apiKey: string, model: string) => Provider;
  readonly ok: unknown;
  readonly truncated: unknown;
  readonly refused: unknown;
  readonly prose: unknown;
  readonly errorBody: (message: string) => unknown;
}

const anthropicMessage = (over: Record<string, unknown>): unknown => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: ANSWER }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 2 },
  ...over,
});

const openaiCompletion = (message: Record<string, unknown>, finish: string): unknown => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-5',
  choices: [{ index: 0, message: { role: 'assistant', refusal: null, ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
});

const ADAPTERS: readonly Adapter[] = [
  {
    name: 'anthropic',
    build: (fetch) => anthropicProvider({ apiKey: SECRET, model: 'claude-opus-5', maxRetries: 0, fetch }),
    bad: (apiKey, model) => anthropicProvider({ apiKey, model }),
    ok: anthropicMessage({}),
    truncated: anthropicMessage({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"sql":"SELECT' }],
    }),
    refused: anthropicMessage({ stop_reason: 'refusal', stop_details: null, content: [] }),
    prose: anthropicMessage({ content: [{ type: 'text', text: 'Sure! Here you go:' }] }),
    errorBody: (message) => ({ type: 'error', error: { type: 'invalid_request_error', message } }),
  },
  {
    name: 'openai',
    build: (fetch) => openaiProvider({ apiKey: SECRET, model: 'gpt-5', maxRetries: 0, fetch }),
    bad: (apiKey, model) => openaiProvider({ apiKey, model }),
    ok: openaiCompletion({ content: ANSWER }, 'stop'),
    truncated: openaiCompletion({ content: '{"sql":"SELECT' }, 'length'),
    refused: openaiCompletion({ content: null, refusal: 'no' }, 'stop'),
    prose: openaiCompletion({ content: 'Sure! Here you go:' }, 'stop'),
    errorBody: (message) => ({ error: { type: 'invalid_request_error', message } }),
  },
];

for (const a of ADAPTERS) {
  const run = (reply: () => Reply) => {
    const t = transport(reply);
    return a.build(t.impl);
  };
  const body = (b: unknown) => run(() => ({ body: b }));
  const failing = (status: number, message = 'boom') => run(() => ({ status, body: a.errorBody(message) }));
  const caught = async (p: Provider): Promise<ModelError> =>
    (await p.complete(ASK).catch((e: unknown) => e)) as ModelError;

  describe(`${a.name} honours the provider contract`, () => {
    it('names itself and the model it was configured with', () => {
      const p = body(a.ok);
      expect(p.id).toBe(a.name);
      expect(typeof p.model).toBe('string');
    });

    it('returns the object the model produced', async () => {
      expect((await body(a.ok).complete(ASK)).output).toEqual({ sql: 'SELECT count(*) FROM users' });
    });

    it('reports every usage counter as a number', async () => {
      const usage = (await body(a.ok).complete(ASK)).usage;
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
        expect(typeof usage[key], key).toBe('number');
      }
    });

    it('refuses a truncated reply rather than returning a fragment', async () => {
      const err = await caught(body(a.truncated));
      expect(err).toBeInstanceOf(ModelError);
      expect(err.kind).toBe('truncated');
      expect(err.retryable).toBe(false);
    });

    it('reports a refusal as a refusal', async () => {
      expect((await caught(body(a.refused))).kind).toBe('refused');
    });

    it('rejects prose that is not the object we asked for', async () => {
      expect((await caught(body(a.prose))).kind).toBe('no_output');
    });

    it('classifies failures the same way', async () => {
      const cases: ReadonlyArray<readonly [number, string, boolean]> = [
        [401, 'auth', false],
        [429, 'rate_limited', true],
        [503, 'transport', true],
        [400, 'bad_request', false],
      ];
      for (const [status, kind, retryable] of cases) {
        const err = await caught(failing(status));
        expect(err.kind, `${status}`).toBe(kind);
        expect(err.retryable, `${status}`).toBe(retryable);
      }
    });

    it('never lets the key reach an error a caller sees', async () => {
      const err = await caught(failing(400, `rejected key ${SECRET}`));
      expect(err.message).not.toContain(SECRET);
      expect(err.message).toContain('[redacted]');
    });

    it('says plainly that the key is the caller to supply', () => {
      expect(() => a.bad('', 'm')).toThrow(/never supplies one/);
      expect(() => a.bad('   ', 'm')).toThrow(/API key is required/);
    });

    it('requires a model id', () => {
      expect(() => a.bad('k', '')).toThrow(/model id is required/);
    });
  });
}
