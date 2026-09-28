import type { AskOkResponse, ResultSet } from '@insightkit/protocol';
import { type CSSProperties, type ReactElement, useRef } from 'react';
import { Chart } from './chart.js';
import { Frame, type Theme } from './frame.js';
import { type FetchLike, useAsk } from './use-ask.js';
import { closeMessage, type EventSourceFactory, useLiveResult } from './use-live-result.js';

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** Only an instant can be localised; a zoneless timestamp is shown as the server wrote it (ADR 0007). */
const shownAt = (at: string): string => {
  if (!ZONED.test(at)) return at;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleTimeString();
};

/** The server routes on the last path segment, so both live under one mounted base. */
const joined = (base: string, segment: string): string => `${base.replace(/\/+$/, '')}/${segment}`;

export interface InsightProps {
  /** Where the handler is mounted. `ask` and `subscribe` hang off it. */
  readonly endpoint: string;
  readonly question: string;
  readonly live?: boolean | undefined;
  /** Defaults to `${endpoint}/subscribe`, which is where the server listens. */
  readonly streamEndpoint?: string | undefined;
  readonly intervalMs?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly eventSourceFactory?: EventSourceFactory | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly theme?: Theme | undefined;
}

export const Insight = (props: InsightProps): ReactElement | null => {
  const { state, reload } = useAsk({
    endpoint: joined(props.endpoint, 'ask'),
    question: props.question,
    headers: props.headers,
    fetchImpl: props.fetchImpl,
  });

  const answer = state.phase === 'ok' ? state.answer : null;
  const previous = useRef<AskOkResponse | null>(null);
  if (answer !== null) previous.current = answer;

  const live = useLiveResult({
    endpoint: props.streamEndpoint ?? joined(props.endpoint, 'subscribe'),
    token: props.live === true && answer !== null ? (answer.stream ?? null) : null,
    intervalMs: props.intervalMs,
    eventSourceFactory: props.eventSourceFactory,
  });

  const chartFor = (ok: AskOkResponse, busy: boolean): ReactElement => {
    const snapshot = live.state.phase === 'idle' ? null : live.state.snapshot;
    const data: ResultSet = snapshot === null ? ok.data : snapshot.data;
    const truncated = snapshot === null ? ok.truncated : snapshot.truncated;
    return (
      <div className={busy ? 'ik-busy' : undefined} aria-busy={busy ? true : undefined}>
        <Chart
          spec={ok.chart}
          data={data}
          truncated={truncated}
          className={props.className}
          style={props.style}
          theme={props.theme}
        />
        {snapshot === null ? null : (
          <p className="ik-note" data-ik-live="live">
            <span>{`Updated ${shownAt(snapshot.at)}.`}</span>
          </p>
        )}
        {live.state.phase === 'closed' ? (
          <p className="ik-note" data-ik-live="closed">
            <span>{closeMessage(live.state.reason)}</span>
          </p>
        ) : null}
        {live.state.phase === 'failed' ? (
          <p className="ik-note" data-ik-live="failed">
            <span>{live.state.message}</span>
          </p>
        ) : null}
      </div>
    );
  };

  const panel = (state_: string, role: 'status' | 'alert', head: string, body: string, retry: boolean) => (
    <Frame className={props.className} style={props.style} theme={props.theme} state={state_}>
      <div className="ik-state" role={role} aria-live={role === 'status' ? 'polite' : undefined}>
        <p className="ik-state-head">{head}</p>
        <p>{body}</p>
        {retry ? (
          <button type="button" className="ik-retry" onClick={reload}>
            Try again
          </button>
        ) : null}
      </div>
    </Frame>
  );

  switch (state.phase) {
    case 'idle':
      return null;
    case 'loading':
      return previous.current === null ? (
        <Frame className={props.className} style={props.style} theme={props.theme} state="loading" busy>
          <p className="ik-empty" role="status" aria-live="polite">
            Working on it…
          </p>
        </Frame>
      ) : (
        chartFor(previous.current, true)
      );
    case 'ok':
      return chartFor(state.answer, false);
    case 'unanswerable':
      return panel('unanswerable', 'status', 'No answer in this data', state.message, false);
    case 'refused':
      return panel('refused', 'status', 'That question was not allowed', state.message, false);
    default:
      return panel('failed', 'alert', 'Something went wrong', state.message, true);
  }
};
