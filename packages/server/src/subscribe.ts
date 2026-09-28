import type { StreamCloseReason, StreamEvent } from '@insightkit/protocol';
import { PROTOCOL_VERSION, parseStreamEvent, parseSubscribeRequest } from '@insightkit/protocol';
import { FALLBACK_IDENTITY } from './ask.js';
import type { LiveRuntime, Runtime } from './config.js';
import { clampInterval } from './config.js';
import type { BodyOutcome } from './http.js';
import { readJsonBody, streamProblem } from './http.js';
import { ERROR_MESSAGE, toResultSet } from './narrow.js';
import { resolveScope, runScopedRead } from './scope.js';

const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  // nginx buffers a proxied response by default, which holds every frame until the stream ends.
  'x-accel-buffering': 'no',
};

/** Frames buffered before a slow reader is treated as absent and snapshots are dropped. */
const QUEUE_DEPTH = 8;

const encoder = new TextEncoder();

const unref = (handle: unknown): void => {
  if (typeof handle !== 'object' || handle === null) return;
  const fn = (handle as { unref?: unknown }).unref;
  if (typeof fn === 'function') (fn as () => void).call(handle);
};

const frameOf = (event: StreamEvent): string | null => {
  const checked = parseStreamEvent(event);
  return checked.ok ? `data: ${JSON.stringify(checked.value)}\n\n` : null;
};

interface Handle {
  readonly identity: string;
  readonly stop: (reason: StreamCloseReason | null) => void;
}

export interface StreamRegistry {
  take(token: string, handle: Handle): void;
  release(token: string, handle: Handle): void;
  countFor(identity: string): number;
  size(): number;
  shutdown(): void;
}

export function createStreamRegistry(): StreamRegistry {
  const live = new Map<string, Handle>();
  return {
    take(token, handle) {
      // One stream per token. A second subscriber to the same token displaces the first
      // rather than doubling the query load behind one approval.
      live.get(token)?.stop('replaced');
      live.set(token, handle);
    },
    release(token, handle) {
      if (live.get(token) === handle) live.delete(token);
    },
    countFor(identity) {
      let count = 0;
      for (const handle of live.values()) if (handle.identity === identity) count += 1;
      return count;
    },
    size: () => live.size,
    shutdown() {
      for (const handle of [...live.values()]) handle.stop('shutdown');
      live.clear();
    },
  };
}

function closedStream(reason: StreamCloseReason): Response {
  const frame = frameOf({ type: 'closed', protocol: PROTOCOL_VERSION, reason });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (frame !== null) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { ...SSE_HEADERS } });
}

/** GET carries the request in the query string, for a host whose client is an `EventSource`. */
async function subscribeBody(request: Request, maxBytes: number): Promise<BodyOutcome> {
  if (request.method.toUpperCase() !== 'GET') return readJsonBody(request, maxBytes);
  const params = new URL(request.url).searchParams;
  const token = params.get('token');
  const interval = params.get('intervalMs');
  return {
    ok: true,
    value: {
      ...(token === null ? {} : { token }),
      ...(interval === null ? {} : { intervalMs: Number(interval) }),
    },
  };
}

/**
 * Re-runs the query that was already approved, on a timer, and never re-plans. A timer that
 * called a model would be unbounded spend and a chart whose shape changes under the viewer.
 */
export async function handleSubscribe(
  rt: Runtime,
  request: Request,
  registry: StreamRegistry,
): Promise<Response> {
  if (rt.live === null) return streamProblem(503, 'live updates are not enabled on this server');
  // A hoisted `tick` may be called before the check above, so the narrowing is re-stated as a type.
  const live: LiveRuntime = rt.live;

  const method = request.method.toUpperCase();
  if (method !== 'POST' && method !== 'GET') {
    return streamProblem(405, 'use POST or GET to subscribe', { allow: 'POST, GET' });
  }

  const scoped = await resolveScope(
    rt.tenancy,
    rt.tokenFrom(request),
    rt.identify(request) ?? FALLBACK_IDENTITY,
  );
  if (!scoped.ok) {
    rt.onError({ phase: 'auth', identity: null, error: scoped.cause ?? scoped.detail });
    const headers = scoped.status === 401 ? { 'www-authenticate': 'Bearer' } : {};
    return streamProblem(scoped.status, 'this subscription could not be authorised', headers);
  }
  const scope = scoped.scope;

  const body = await subscribeBody(request, rt.limits.maxBodyBytes);
  if (!body.ok) return streamProblem(body.status, body.detail);

  const parsed = parseSubscribeRequest(body.value);
  if (!parsed.ok) return streamProblem(400, 'the subscribe request was not accepted');

  if (registry.size() >= live.maxTotal) {
    return streamProblem(503, 'this server is carrying as many live queries as it can', {
      'retry-after': '5',
    });
  }
  if (registry.countFor(scope.identity) >= live.maxPerIdentity) {
    return streamProblem(429, 'too many live queries for this identity', { 'retry-after': '5' });
  }

  const token = parsed.value.token;
  const record = live.store.get(token, rt.now());
  // Unknown, expired and someone else's all answer the same way, so a token is not an oracle.
  if (record === undefined || record.identity !== scope.identity) return closedStream('expired');

  const intervalMs = clampInterval(live, parsed.value.intervalMs);
  const startedAt = rt.now();
  const signal = request.signal;

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let lastWrite = startedAt;
  let consecutiveErrors = 0;

  const write = (text: string): void => {
    if (closed || controller === null) return;
    try {
      controller.enqueue(encoder.encode(text));
      lastWrite = rt.now();
    } catch {
      finish(null);
    }
  };

  const emit = (event: StreamEvent): void => {
    const frame = frameOf(event);
    if (frame === null) {
      rt.onError({
        phase: 'stream',
        identity: scope.identity,
        error: new Error('a stream frame was rejected'),
      });
      finish('failed');
      return;
    }
    write(frame);
  };

  const onAbort = (): void => finish(null);

  function finish(reason: StreamCloseReason | null): void {
    if (closed) return;
    if (reason !== null && controller !== null) {
      const frame = frameOf({ type: 'closed', protocol: PROTOCOL_VERSION, reason });
      if (frame !== null) {
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* the consumer is already gone */
        }
      }
    }
    closed = true;
    if (timer !== null) clearTimeout(timer);
    if (keepalive !== null) clearInterval(keepalive);
    timer = null;
    keepalive = null;
    signal.removeEventListener('abort', onAbort);
    registry.release(token, handle);
    try {
      controller?.close();
    } catch {
      /* already closed by the consumer */
    }
  }

  const handle: Handle = { identity: scope.identity, stop: (reason) => finish(reason) };

  const schedule = (): void => {
    if (closed) return;
    timer = setTimeout(() => void tick(), intervalMs);
    unref(timer);
  };

  async function tick(): Promise<void> {
    if (closed) return;
    if (rt.now() - startedAt >= live.maxDurationMs) return finish('expired');

    const current = live.store.get(token, rt.now());
    if (current === undefined) return finish('expired');

    // A reader that has stopped consuming gets the next snapshot, not a queue of stale ones.
    if (controller !== null && (controller.desiredSize ?? 1) <= 0) {
      schedule();
      return;
    }

    try {
      const read = await runScopedRead(rt.source, current.query, scope, rt.read);
      if (closed) return;
      consecutiveErrors = 0;
      emit({
        type: 'snapshot',
        protocol: PROTOCOL_VERSION,
        data: toResultSet(read.rows),
        truncated: read.reachedLimit,
        at: new Date(rt.now()).toISOString(),
      });
    } catch (error) {
      if (closed) return;
      rt.onError({ phase: 'stream', identity: scope.identity, error });
      consecutiveErrors += 1;
      emit({ type: 'error', protocol: PROTOCOL_VERSION, message: ERROR_MESSAGE });
      if (consecutiveErrors >= live.maxConsecutiveErrors) return finish('failed');
    }
    schedule();
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      start(open) {
        controller = open;
        registry.take(token, handle);
        if (signal.aborted) {
          finish(null);
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        // Bytes before the first query, so a proxy sees an open response immediately, and a
        // reconnecting EventSource waits our interval rather than its own default.
        write(`retry: ${intervalMs}\n:ok\n\n`);
        keepalive = setInterval(() => {
          if (rt.now() - lastWrite >= live.keepaliveMs) write(': keepalive\n\n');
        }, live.keepaliveMs);
        unref(keepalive);
        void tick();
      },
      cancel() {
        finish(null);
      },
    },
    { highWaterMark: QUEUE_DEPTH },
  );

  return new Response(stream, { status: 200, headers: { ...SSE_HEADERS } });
}
