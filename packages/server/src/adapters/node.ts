import { PROTOCOL_VERSION } from '@insightkit/protocol';

export type WebHandler = (request: Request) => Promise<Response>;

export type NodeHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Structural, so nothing here depends on express or on `node:http`. `IncomingMessage` is an
 * async iterable of chunks, which is all this needs to read a body.
 */
export interface NodeRequestLike extends AsyncIterable<Uint8Array> {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: NodeHeaders;
}

export interface NodeResponseLike {
  writeHead(status: number, headers?: Record<string, string | string[]>): unknown;
  write(chunk: Uint8Array): boolean;
  end(chunk?: Uint8Array): unknown;
  on(event: 'close', listener: () => void): unknown;
  once?: (event: 'drain', listener: () => void) => unknown;
  flushHeaders?: () => void;
  readonly writableEnded?: boolean;
}

export interface NodeAdapterOptions {
  /** Refused before the handler sees it, so a body never accumulates unbounded in memory. */
  readonly maxBodyBytes?: number;
  /** Used to build an absolute URL when the request carries no Host header. */
  readonly origin?: string;
}

const DEFAULT_MAX_BODY = 1_048_576;

const single = (value: string | readonly string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(', ') : (value as string | undefined);

const toHeaders = (headers: NodeHeaders): Headers => {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const flat = single(value);
    if (flat !== undefined) out.set(name, flat);
  }
  return out;
};

const originOf = (request: NodeRequestLike, fallback: string): string => {
  const host = single(request.headers.host);
  if (host === undefined || host === '') return fallback;
  const proto = single(request.headers['x-forwarded-proto'])?.split(',')[0]?.trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
};

async function collect(request: NodeRequestLike, max: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return joined;
}

const HEADERLESS = new Set(['GET', 'HEAD']);

export async function toWebRequest(
  request: NodeRequestLike,
  options: NodeAdapterOptions,
  signal: AbortSignal,
): Promise<Request | null> {
  const method = (request.method ?? 'GET').toUpperCase();
  const url = new URL(request.url ?? '/', originOf(request, options.origin ?? 'http://insightkit.invalid'));
  const headers = toHeaders(request.headers);
  if (HEADERLESS.has(method)) return new Request(url, { method, headers, signal });

  const body = await collect(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY);
  if (body === null) return null;
  return new Request(url, { method, headers, body, signal });
}

const headerRecord = (headers: Headers): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') {
      const existing = out[name];
      out[name] = Array.isArray(existing) ? [...existing, value] : [value];
      return;
    }
    out[name] = value;
  });
  return out;
};

/**
 * Express, Connect and a bare `node:http` server. The response is written chunk by chunk as it
 * arrives, so an SSE stream reaches the client rather than being buffered until it ends.
 */
export function toNodeHandler(
  handler: WebHandler,
  options: NodeAdapterOptions = {},
): (request: NodeRequestLike, response: NodeResponseLike) => Promise<void> {
  return async (request, response) => {
    const aborter = new AbortController();
    response.on('close', () => aborter.abort());

    const web = await toWebRequest(request, options, aborter.signal);
    if (web === null) {
      const body = { status: 'error', protocol: PROTOCOL_VERSION, message: 'the request body is too large' };
      response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      response.end(new TextEncoder().encode(JSON.stringify(body)));
      return;
    }

    const result = await handler(web);
    response.writeHead(result.status, headerRecord(result.headers));
    response.flushHeaders?.();

    const body = result.body;
    if (body === null) {
      response.end();
      return;
    }

    const reader = body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (aborter.signal.aborted || response.writableEnded === true) break;
        // Waiting for drain pushes backpressure into the web stream, so a client that has
        // stopped reading stops the query loop instead of filling the socket buffer.
        if (!response.write(next.value) && response.once !== undefined) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              aborter.signal.removeEventListener('abort', done);
              resolve();
            };
            aborter.signal.addEventListener('abort', done, { once: true });
            response.once?.('drain', done);
          });
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      if (response.writableEnded !== true) response.end();
    }
  };
}
