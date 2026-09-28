import type { AskResponse, StreamEvent } from '@insightkit/protocol';
import { PROTOCOL_VERSION, parseAskResponse, parseStreamEvent } from '@insightkit/protocol';
import { ERROR_MESSAGE, errorResponse } from './narrow.js';

export const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const BEARER = /^Bearer\s+(\S+)$/i;

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const match = BEARER.exec(header.trim());
  return match?.[1] ?? null;
}

export type BodyOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413 | 415; readonly detail: string };

const isJson = (request: Request): boolean => {
  const type = request.headers.get('content-type');
  if (type === null) return false;
  return type.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
};

/**
 * Reads at most `maxBytes` and refuses the rest, rather than buffering whatever arrives and
 * checking afterwards. `content-length` is a hint from the caller, so the stream is capped too.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyOutcome> {
  if (!isJson(request)) return { ok: false, status: 415, detail: 'expected application/json' };

  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, status: 413, detail: `body declares ${length} bytes, over the limit` };
    }
  }

  const body = request.body;
  let text: string;
  if (body === null) {
    text = await request.text();
    if (text.length > maxBytes) return { ok: false, status: 413, detail: 'body is over the limit' };
  } else {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          return { ok: false, status: 413, detail: `body is over ${maxBytes} bytes` };
        }
        chunks.push(next.value);
      }
    } catch {
      return { ok: false, status: 400, detail: 'the request body could not be read' };
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.byteLength;
    }
    text = new TextDecoder('utf-8', { fatal: false }).decode(joined);
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, detail: 'the request body is not valid JSON' };
  }
}

/** The last guard before serialising. A leak becomes a 500 here rather than a disclosure. */
export function askResponse(
  body: AskResponse,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
  onLeak?: (issue: string) => void,
): Response {
  const checked = parseAskResponse(body);
  if (!checked.ok) {
    onLeak?.(checked.error);
    return new Response(
      JSON.stringify({ status: 'error', protocol: PROTOCOL_VERSION, message: ERROR_MESSAGE }),
      {
        status: 500,
        headers: { ...JSON_HEADERS },
      },
    );
  }
  return new Response(JSON.stringify(checked.value), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export const askError = (
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response => askResponse(errorResponse(message), status, headers);

/** A subscribe request that never becomes a stream answers in the stream's own vocabulary. */
export function streamProblem(
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const body: StreamEvent = { type: 'error', protocol: PROTOCOL_VERSION, message };
  const checked = parseStreamEvent(body);
  const payload = checked.ok
    ? checked.value
    : { type: 'error', protocol: PROTOCOL_VERSION, message: ERROR_MESSAGE };
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...headers } });
}
