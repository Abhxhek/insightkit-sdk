/**
 * What the planner needs from a model client, defined here rather than imported from
 * `@insightkit/llm` for the same reason `SqlClient` is not imported from `pg`: the
 * planner stays testable without a provider, a second client is an implementation of
 * an interface rather than a rewrite, and core takes on no dependency to reach a model.
 * `@insightkit/llm` satisfies this shape structurally.
 */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly schema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
}

export interface ModelCompletion {
  readonly output: unknown;
  readonly usage: ModelUsage;
  readonly model: string;
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelCompletion>;
}

/**
 * Reads the failure kind off a provider error without knowing the class, so a caller
 * can supply any client. Adapters in `@insightkit/llm` carry `kind` and `retryable`.
 */
export function failureKind(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const kind = (err as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}
