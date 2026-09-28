// @vitest-environment jsdom
import { PROTOCOL_VERSION } from '@insightkit/protocol';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventSourceLike } from '../src/use-live-result.js';
import { useLiveResult } from '../src/use-live-result.js';

afterEach(cleanup);

class FakeSource implements EventSourceLike {
  readyState = 0;
  closes = 0;
  readonly url: string;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closes += 1;
    this.readyState = 2;
  }

  emit(type: string, data?: unknown): void {
    const event = { type, data } as unknown as Event;
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    });
  }
}

const snapshot = (rows: readonly (readonly string[])[]) => ({
  type: 'snapshot',
  protocol: PROTOCOL_VERSION,
  data: { columns: ['method', 'users'], rows },
  truncated: false,
  at: '2026-09-29T09:00:00Z',
});

let made: FakeSource[] = [];
afterEach(() => {
  made = [];
});

const factory = (url: string): EventSourceLike => {
  const source = new FakeSource(url);
  made.push(source);
  return source;
};

const last = (): FakeSource => {
  const source = made[made.length - 1];
  if (source === undefined) throw new Error('no EventSource was opened');
  return source;
};

const Harness = (props: { readonly token: string | null; readonly intervalMs?: number }): ReactElement => {
  const { state } = useLiveResult({
    endpoint: '/api/ask/stream',
    token: props.token,
    intervalMs: props.intervalMs,
    eventSourceFactory: factory,
  });
  return (
    <output data-testid="live">
      {state.phase}
      {state.phase === 'closed' ? `:${state.reason}` : ''}
      {state.phase === 'live' ? `:${String(state.snapshot.data.rows.length)}` : ''}
      {state.phase === 'failed' ? `:${state.message}` : ''}
    </output>
  );
};

const text = (): string => screen.getByTestId('live').textContent ?? '';

describe('useLiveResult', () => {
  it('stays idle without a token and never opens a connection', () => {
    render(<Harness token={null} />);
    expect(text()).toBe('idle');
    expect(made).toHaveLength(0);
  });

  it('hands the opaque token back in the subscribe URL', () => {
    render(<Harness token="tok 1/2" intervalMs={5000} />);
    expect(last().url).toBe('/api/ask/stream?token=tok%201%2F2&intervalMs=5000');
  });

  it('surfaces the latest validated snapshot', async () => {
    render(<Harness token="tok" />);
    last().emit('message', JSON.stringify(snapshot([['google', '12']])));
    await waitFor(() => {
      expect(text()).toBe('live:1');
    });
    last().emit(
      'message',
      JSON.stringify(
        snapshot([
          ['google', '12'],
          ['email', '7'],
        ]),
      ),
    );
    await waitFor(() => {
      expect(text()).toBe('live:2');
    });
  });

  it('closes with the reason and does not reconnect', async () => {
    render(<Harness token="tok" />);
    const source = last();
    source.emit('message', JSON.stringify({ type: 'closed', protocol: PROTOCOL_VERSION, reason: 'expired' }));
    await waitFor(() => {
      expect(text()).toBe('closed:expired');
    });
    expect(source.closes).toBe(1);
    expect(made).toHaveLength(1);
  });

  it('stops consuming a feed whose frames do not validate', async () => {
    render(<Harness token="tok" />);
    const source = last();
    source.emit(
      'message',
      JSON.stringify({ type: 'snapshot', protocol: PROTOCOL_VERSION, at: '2026-09-29' }),
    );
    await waitFor(() => {
      expect(text()).toContain('failed');
    });
    expect(source.closes).toBe(1);
  });

  it('keeps a protocol error frame non-terminal', async () => {
    render(<Harness token="tok" />);
    const source = last();
    source.emit(
      'message',
      JSON.stringify({ type: 'error', protocol: PROTOCOL_VERSION, message: 'query timed out' }),
    );
    await waitFor(() => {
      expect(text()).toBe('failed:query timed out');
    });
    expect(source.closes).toBe(0);
    source.emit('message', JSON.stringify(snapshot([['google', '12']])));
    await waitFor(() => {
      expect(text()).toBe('live:1');
    });
  });

  it('gives up once the browser has given up', async () => {
    render(<Harness token="tok" />);
    const source = last();
    source.readyState = 2;
    source.emit('error');
    await waitFor(() => {
      expect(text()).toContain('failed');
    });
  });

  it('closes its EventSource on unmount, so a subscription cannot outlive its component', () => {
    const view = render(<Harness token="tok" />);
    const source = last();
    expect(source.closes).toBe(0);
    view.unmount();
    expect(source.closes).toBe(1);
  });

  it('closes the old connection when the token changes', () => {
    const view = render(<Harness token="tok-a" />);
    const first = last();
    view.rerender(<Harness token="tok-b" />);
    expect(first.closes).toBe(1);
    expect(made).toHaveLength(2);
  });
});
