import Anthropic from '@anthropic-ai/sdk';
import type { Completion, CompletionRequest, Provider, Usage } from './types.js';
import { ModelError } from './types.js';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /** Escape hatch for a proxy or a test transport. */
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
// The SDK counts this in milliseconds; the Python one counts seconds. Easy to carry
// a wrong unit across from an example and end up with a 60 ms or a 60,000 s deadline.
const DEFAULT_TIMEOUT_MS = 60_000;

const usageOf = (usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Usage => ({
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
});

function translate(err: unknown): ModelError {
  // Only the message and status are carried over. The provider's error object holds
  // request configuration, so it is never attached or re-thrown as a cause.
  const text = err instanceof Error ? err.message : String(err);
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ModelError('timeout', `the model did not respond in time: ${text}`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ModelError('rate_limited', `the provider is rate limiting: ${text}`, { status: 429 });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new ModelError('auth', `the provider rejected the API key: ${text}`, { status: 401 });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const kind = status !== undefined && status >= 500 ? 'transport' : 'bad_request';
    return new ModelError(kind, text, status === undefined ? {} : { status });
  }
  return new ModelError('transport', text);
}

export function anthropicProvider(options: AnthropicOptions): Provider {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
    throw new ModelError(
      'auth',
      'an API key is required. InsightKit never supplies one: pass the key for the provider you chose.',
    );
  }
  if (typeof options.model !== 'string' || options.model.trim() === '') {
    throw new ModelError('bad_request', 'a model id is required, for example claude-opus-5');
  }

  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? 2,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    id: 'anthropic',
    model: options.model,

    async complete(request: CompletionRequest): Promise<Completion> {
      const maxTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

      // create, not parse: the SDK's parse helper throws on unparseable content
      // before stop_reason can be read, which turns a truncated answer into a generic
      // transport error that a caller would then retry. Ordering matters more than
      // the one JSON.parse the helper saves.
      let message: Awaited<ReturnType<typeof client.messages.create>>;
      try {
        message = await client.messages.create(
          {
            model: options.model,
            max_tokens: maxTokens,
            system: request.system,
            messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            output_config: {
              format: { type: 'json_schema', schema: { ...request.schema } },
              ...(request.effort === undefined ? {} : { effort: request.effort }),
            },
          },
          { timeout: request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        );
      } catch (err) {
        throw translate(err);
      }

      // Checked before the content is read. A refusal returns HTTP 200 with nothing
      // useful in it, so treating it as a normal response reads as an empty answer.
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category ?? 'unspecified';
        throw new ModelError('refused', `the model declined this request (${category})`);
      }
      // Truncation is the dangerous one here: a cut-off statement can still be valid
      // syntax, so it has to be an error rather than a shorter answer.
      if (message.stop_reason === 'max_tokens') {
        throw new ModelError(
          'truncated',
          `the response reached the ${maxTokens} token limit, so it is incomplete`,
        );
      }

      const text = message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text.trim() === '') {
        throw new ModelError('no_output', 'the model returned no text to read an object from');
      }

      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new ModelError('no_output', 'the model returned text that is not the object we asked for');
      }

      return { output, usage: usageOf(message.usage), model: message.model };
    },
  };
}
