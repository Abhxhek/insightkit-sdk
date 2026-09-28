import type { AskOkResponse } from '@insightkit/protocol';
import { PROTOCOL_VERSION, parseAskResponse, protocolVersionOf } from '@insightkit/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** `server` is the protocol's own `error` status; the rest are this client's view of the transport. */
export type AskFailureCause = 'server' | 'network' | 'http' | 'malformed' | 'protocol';

export type AskState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading'; readonly question: string }
  | { readonly phase: 'ok'; readonly question: string; readonly answer: AskOkResponse }
  | { readonly phase: 'unanswerable'; readonly question: string; readonly message: string }
  | { readonly phase: 'refused'; readonly question: string; readonly message: string }
  | {
      readonly phase: 'failed';
      readonly question: string;
      readonly message: string;
      readonly cause: AskFailureCause;
      readonly detail: string | null;
    };

export interface UseAskOptions {
  readonly endpoint: string;
  readonly question: string | null;
  readonly enabled?: boolean | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}

export interface UseAskResult {
  readonly state: AskState;
  readonly reload: () => void;
}

const isAbort = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { readonly name?: unknown }).name === 'AbortError';

export const useAsk = (options: UseAskOptions): UseAskResult => {
  const { endpoint, question, enabled = true } = options;
  const [state, setState] = useState<AskState>({ phase: 'idle' });
  const [nonce, setNonce] = useState(0);
  const sequence = useRef(0);

  // Read through refs so a host passing an inline object literal does not refetch on every render.
  const extras = useRef(options.headers);
  const fetcher = useRef(options.fetchImpl);
  extras.current = options.headers;
  fetcher.current = options.fetchImpl;

  useEffect(() => {
    if (!enabled || question === null || question.trim() === '') {
      setState({ phase: 'idle' });
      return;
    }
    const controller = new AbortController();
    sequence.current += 1;
    const ticket = sequence.current;
    const settle = (next: AskState): void => {
      if (sequence.current === ticket) setState(next);
    };
    setState({ phase: 'loading', question });

    const fail = (cause: AskFailureCause, message: string, detail: string | null): void =>
      settle({ phase: 'failed', question, message, cause, detail });

    const run = async (): Promise<void> => {
      const send = fetcher.current ?? fetch;
      let response: Response;
      try {
        response = await send(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...extras.current },
          body: JSON.stringify({ question }),
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbort(error)) return;
        fail('network', 'Could not reach the server.', error instanceof Error ? error.message : null);
        return;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (isAbort(error)) return;
        fail(
          response.ok ? 'malformed' : 'http',
          response.ok
            ? 'The server sent a reply this client could not read.'
            : 'The server rejected the question.',
          `HTTP ${response.status}`,
        );
        return;
      }

      const version = protocolVersionOf(payload);
      if (version !== null && version !== PROTOCOL_VERSION) {
        fail(
          'protocol',
          'This page is out of date. Reload to pick up the current version.',
          `server speaks protocol ${version}, this client speaks ${PROTOCOL_VERSION}`,
        );
        return;
      }

      // A non-2xx may still carry a valid AskResponse, so the body decides before the status does.
      const parsed = parseAskResponse(payload);
      if (!parsed.ok) {
        fail(
          response.ok ? 'malformed' : 'http',
          response.ok
            ? 'The server sent a reply this client could not read.'
            : 'The server rejected the question.',
          response.ok ? parsed.error : `HTTP ${response.status}: ${parsed.error}`,
        );
        return;
      }

      const answer = parsed.value;
      switch (answer.status) {
        case 'ok':
          settle({ phase: 'ok', question, answer });
          return;
        case 'unanswerable':
          settle({ phase: 'unanswerable', question, message: answer.message });
          return;
        case 'refused':
          settle({ phase: 'refused', question, message: answer.message });
          return;
        default:
          fail('server', answer.message, null);
      }
    };

    void run();
    return () => {
      controller.abort();
    };
  }, [endpoint, question, enabled, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { state, reload };
};
