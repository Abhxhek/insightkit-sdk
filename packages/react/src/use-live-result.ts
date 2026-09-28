import type { StreamCloseReason, StreamSnapshot } from '@insightkit/protocol';
import { parseStreamEvent } from '@insightkit/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
  readonly readyState: number;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export type LiveState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'connecting'; readonly snapshot: StreamSnapshot | null }
  | { readonly phase: 'live'; readonly snapshot: StreamSnapshot }
  | {
      readonly phase: 'closed';
      readonly reason: StreamCloseReason;
      readonly snapshot: StreamSnapshot | null;
    }
  | { readonly phase: 'failed'; readonly message: string; readonly snapshot: StreamSnapshot | null };

export interface UseLiveResultOptions {
  readonly endpoint: string;
  /** The opaque token from an `ok` answer. `null` keeps the hook idle. */
  readonly token: string | null;
  readonly intervalMs?: number | undefined;
  readonly enabled?: boolean | undefined;
  readonly withCredentials?: boolean | undefined;
  readonly eventSourceFactory?: EventSourceFactory | undefined;
  readonly maxTransportFailures?: number | undefined;
}

export interface UseLiveResultResult {
  readonly state: LiveState;
  readonly reconnect: () => void;
}

const CLOSED = 2;

const withParams = (endpoint: string, params: readonly (readonly [string, string])[]): string => {
  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  if (query === '') return endpoint;
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${query}`;
};

const dataOf = (event: Event): unknown => (event as { readonly data?: unknown }).data;

const REASONS: Record<StreamCloseReason, string> = {
  expired: 'The live feed expired.',
  replaced: 'The live feed was replaced by a newer one.',
  shutdown: 'The server stopped the live feed.',
  failed: 'The live feed stopped after an error.',
};

export const closeMessage = (reason: StreamCloseReason): string => REASONS[reason];

export const useLiveResult = (options: UseLiveResultOptions): UseLiveResultResult => {
  const { endpoint, token, enabled = true, intervalMs, withCredentials, maxTransportFailures = 6 } = options;
  const [state, setState] = useState<LiveState>({ phase: 'idle' });
  const [nonce, setNonce] = useState(0);
  const snapshot = useRef<StreamSnapshot | null>(null);
  const factory = useRef(options.eventSourceFactory);
  factory.current = options.eventSourceFactory;

  useEffect(() => {
    if (!enabled || token === null || token === '') {
      snapshot.current = null;
      setState({ phase: 'idle' });
      return;
    }
    const build =
      factory.current ??
      ((url: string): EventSourceLike => new EventSource(url, { withCredentials: withCredentials === true }));
    if (factory.current === undefined && typeof EventSource === 'undefined') {
      setState({ phase: 'failed', message: 'This browser cannot open a live feed.', snapshot: null });
      return;
    }

    const params: (readonly [string, string])[] = [['token', token]];
    if (intervalMs !== undefined) params.push(['intervalMs', String(intervalMs)]);

    let source: EventSourceLike;
    try {
      source = build(withParams(endpoint, params));
    } catch {
      setState({ phase: 'failed', message: 'Could not open a live feed.', snapshot: null });
      return;
    }

    let done = false;
    let failures = 0;
    snapshot.current = null;
    setState({ phase: 'connecting', snapshot: null });

    const stop = (next: LiveState): void => {
      done = true;
      source.close();
      setState(next);
    };

    source.addEventListener('open', () => {
      failures = 0;
      if (!done) setState({ phase: 'connecting', snapshot: snapshot.current });
    });

    source.addEventListener('message', (event) => {
      if (done) return;
      const raw = dataOf(event);
      let payload: unknown;
      try {
        payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        stop({
          phase: 'failed',
          message: 'The live feed sent a frame this client could not read.',
          snapshot: snapshot.current,
        });
        return;
      }
      const parsed = parseStreamEvent(payload);
      if (!parsed.ok) {
        // A feed emitting frames we cannot validate is not one to keep consuming.
        stop({
          phase: 'failed',
          message: 'The live feed sent a frame this client could not read.',
          snapshot: snapshot.current,
        });
        return;
      }
      failures = 0;
      const frame = parsed.value;
      if (frame.type === 'snapshot') {
        snapshot.current = frame;
        setState({ phase: 'live', snapshot: frame });
        return;
      }
      if (frame.type === 'closed') {
        stop({ phase: 'closed', reason: frame.reason, snapshot: snapshot.current });
        return;
      }
      setState({ phase: 'failed', message: frame.message, snapshot: snapshot.current });
    });

    source.addEventListener('error', () => {
      if (done) return;
      failures += 1;
      if (source.readyState === CLOSED || failures > maxTransportFailures) {
        stop({ phase: 'failed', message: 'Lost the live feed.', snapshot: snapshot.current });
        return;
      }
      setState({ phase: 'connecting', snapshot: snapshot.current });
    });

    return () => {
      done = true;
      source.close();
    };
  }, [endpoint, token, enabled, intervalMs, withCredentials, maxTransportFailures, nonce]);

  const reconnect = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { state, reconnect };
};
