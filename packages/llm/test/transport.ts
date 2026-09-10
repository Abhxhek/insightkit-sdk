export interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

export interface Reply {
  readonly status?: number;
  readonly body: unknown;
}

/** Drives a real provider SDK against a fake wire, so tests assert the SDK itself. */
export function transport(reply: () => Reply) {
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

export const SECRET = 'sk-ant-secret-key-value-0123456789';

export const SCHEMA = {
  type: 'object',
  properties: { sql: { type: 'string' } },
  required: ['sql'],
  additionalProperties: false,
} as const;
