import { redact } from './redact.js';

export interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export type Effort = 'low' | 'medium' | 'high';

export interface CompletionRequest {
  readonly system: string;
  readonly messages: readonly Message[];
  /** JSON Schema the returned object must satisfy. */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
  readonly effort?: Effort;
  readonly timeoutMs?: number;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface Completion {
  /**
   * Shaped by the provider against the requested schema, but not trusted here. The
   * caller validates it, because a provider guarantee is not a guarantee we made.
   */
  readonly output: unknown;
  readonly usage: Usage;
  readonly model: string;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

export type ModelErrorKind =
  /** Hit the output limit, so whatever came back is a fragment of the answer. */
  | 'truncated'
  /** The model declined to answer. */
  | 'refused'
  /** Finished, but produced nothing matching the requested schema. */
  | 'no_output'
  | 'rate_limited'
  | 'timeout'
  | 'auth'
  | 'bad_request'
  | 'transport';

const RETRYABLE: ReadonlySet<ModelErrorKind> = new Set(['rate_limited', 'timeout', 'transport']);

export interface ModelErrorOptions {
  readonly retryable?: boolean;
  readonly status?: number;
}

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(kind: ModelErrorKind, message: string, options: ModelErrorOptions = {}) {
    super(redact(message));
    this.name = 'ModelError';
    this.kind = kind;
    this.retryable = options.retryable ?? RETRYABLE.has(kind);
    this.status = options.status;
  }
}
