import OpenAI from 'openai';
import type { Completion, CompletionRequest, Provider, Usage } from './types.js';
import { ModelError } from './types.js';

export interface OpenAIOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Point at Azure, a proxy, or any OpenAI-compatible endpoint. */
  readonly baseURL?: string;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /**
   * Structured outputs enforced server side. Requires the schema to set
   * `additionalProperties: false` and list every property in `required`. Turn it off
   * only for a compatible endpoint that does not implement it; the caller validates
   * the result either way.
   */
  readonly strictSchema?: boolean;
  /** Escape hatch for a proxy or a test transport. */
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 60_000;
const SCHEMA_NAME = 'insightkit_result';

const usageOf = (usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): Usage => ({
  inputTokens: usage.prompt_tokens ?? 0,
  outputTokens: usage.completion_tokens ?? 0,
  cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  // Caching is automatic here and writes are not reported, unlike Anthropic where the
  // breakpoint is explicit. Zero means unreported, not that nothing was cached.
  cacheWriteTokens: 0,
});

function translate(err: unknown): ModelError {
  const text = err instanceof Error ? err.message : String(err);
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new ModelError('timeout', `the model did not respond in time: ${text}`);
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new ModelError('rate_limited', `the provider is rate limiting: ${text}`, { status: 429 });
  }
  if (err instanceof OpenAI.AuthenticationError) {
    return new ModelError('auth', `the provider rejected the API key: ${text}`, { status: 401 });
  }
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const kind = status !== undefined && status >= 500 ? 'transport' : 'bad_request';
    return new ModelError(kind, text, status === undefined ? {} : { status });
  }
  return new ModelError('transport', text);
}

export function openaiProvider(options: OpenAIOptions): Provider {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
    throw new ModelError(
      'auth',
      'an API key is required. InsightKit never supplies one: pass the key for the provider you chose.',
    );
  }
  if (typeof options.model !== 'string' || options.model.trim() === '') {
    throw new ModelError('bad_request', 'a model id is required, for example gpt-5');
  }

  const client = new OpenAI({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? 2,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    id: 'openai',
    model: options.model,

    async complete(request: CompletionRequest): Promise<Completion> {
      const maxTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

      // create, not parse: the SDK's parse helper raises on a truncated or refused
      // reply before finish_reason can be read, and the resulting error is classified
      // retryable, so a truncation would be retried until it truncated again.
      let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
      try {
        completion = await client.chat.completions.create(
          {
            model: options.model,
            max_completion_tokens: maxTokens,
            messages: [
              { role: 'system', content: request.system },
              ...request.messages.map((m) => ({ role: m.role, content: m.content })),
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: SCHEMA_NAME,
                schema: { ...request.schema },
                strict: options.strictSchema !== false,
              },
            },
          },
          { timeout: request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        );
      } catch (err) {
        throw translate(err);
      }

      const choice = 'choices' in completion ? completion.choices[0] : undefined;
      if (choice === undefined) {
        throw new ModelError('no_output', 'the provider returned no choices');
      }

      // Read before the content, so a refusal is not mistaken for an empty answer and
      // a fragment is not mistaken for a shorter one.
      if (typeof choice.message.refusal === 'string' && choice.message.refusal !== '') {
        throw new ModelError('refused', `the model declined this request: ${choice.message.refusal}`);
      }
      if (choice.finish_reason === 'content_filter') {
        throw new ModelError('refused', 'the response was stopped by a content filter');
      }
      if (choice.finish_reason === 'length') {
        throw new ModelError(
          'truncated',
          `the response reached the ${maxTokens} token limit, so it is incomplete`,
        );
      }

      const text = choice.message.content ?? '';
      if (text.trim() === '') {
        throw new ModelError('no_output', 'the model returned no text to read an object from');
      }

      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new ModelError('no_output', 'the model returned text that is not the object we asked for');
      }

      return {
        output,
        usage: usageOf(completion.usage ?? {}),
        model: completion.model,
      };
    },
  };
}
