// @vitest-environment jsdom
import { PROTOCOL_VERSION } from '@insightkit/protocol';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Insight } from '../src/insight.js';
import { type AskState, type FetchLike, useAsk } from '../src/use-ask.js';

afterEach(cleanup);

const reply = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as Response;

const sending =
  (body: unknown, status = 200): FetchLike =>
  () =>
    Promise.resolve(reply(body, status));

const chart = { kind: 'bar', x: 'method', y: ['users'], series: null, title: 'Signups' };
const data = {
  columns: ['method', 'users'],
  rows: [
    ['google', '12'],
    ['email', '7'],
  ],
};

const describeState = (state: AskState): string =>
  state.phase === 'failed' ? `failed:${state.cause}` : state.phase;

const Harness = (props: { readonly fetchImpl: FetchLike; readonly question?: string }): ReactElement => {
  const { state } = useAsk({
    endpoint: '/api/ask',
    question: props.question ?? 'how many',
    fetchImpl: props.fetchImpl,
  });
  return (
    <output data-testid="phase">
      {describeState(state)}
      {'message' in state ? `|${state.message}` : ''}
    </output>
  );
};

const phase = async (expected: string): Promise<void> => {
  await waitFor(() => {
    expect(screen.getByTestId('phase').textContent ?? '').toContain(expected);
  });
};

describe('useAsk', () => {
  it('reports ok', async () => {
    render(
      <Harness
        fetchImpl={sending({ status: 'ok', protocol: PROTOCOL_VERSION, chart, data, truncated: false })}
      />,
    );
    await phase('ok');
  });

  it('reports unanswerable with the model reason, not as an error', async () => {
    render(
      <Harness
        fetchImpl={sending({
          status: 'unanswerable',
          protocol: PROTOCOL_VERSION,
          message: 'there is no weather data in this schema',
        })}
      />,
    );
    await phase('unanswerable|there is no weather data in this schema');
  });

  it('reports refused separately from error', async () => {
    render(
      <Harness
        fetchImpl={sending({
          status: 'refused',
          protocol: PROTOCOL_VERSION,
          message: 'that request was not allowed',
        })}
      />,
    );
    await phase('refused|that request was not allowed');
  });

  it('reports the protocol error status as a failure with cause server', async () => {
    render(
      <Harness
        fetchImpl={sending({ status: 'error', protocol: PROTOCOL_VERSION, message: 'something went wrong' })}
      />,
    );
    await phase('failed:server|something went wrong');
  });

  it('rejects a malformed response rather than rendering garbage', async () => {
    render(
      <Harness fetchImpl={sending({ status: 'ok', protocol: PROTOCOL_VERSION, chart, truncated: false })} />,
    );
    await phase('failed:malformed');
  });

  it('rejects a response carrying a field the wire contract does not define', async () => {
    render(
      <Harness
        fetchImpl={sending({
          status: 'refused',
          protocol: PROTOCOL_VERSION,
          message: 'no',
          code: 'E_NOT_SELECT',
        })}
      />,
    );
    await phase('failed:malformed');
  });

  it('rejects a column-shifted result set', async () => {
    render(
      <Harness
        fetchImpl={sending({
          status: 'ok',
          protocol: PROTOCOL_VERSION,
          chart,
          data: { columns: ['a', 'b'], rows: [['only-one']] },
          truncated: false,
        })}
      />,
    );
    await phase('failed:malformed');
  });

  it('names a protocol version mismatch instead of calling it a parse error', async () => {
    render(
      <Harness
        fetchImpl={sending({ status: 'ok', protocol: PROTOCOL_VERSION + 1, chart, data, truncated: false })}
      />,
    );
    await phase('failed:protocol');
  });

  it('reports an unreachable server as a network failure', async () => {
    render(<Harness fetchImpl={() => Promise.reject(new TypeError('failed to fetch'))} />);
    await phase('failed:network');
  });

  it('accepts a valid error body carried on a non-2xx response', async () => {
    render(
      <Harness
        fetchImpl={sending({ status: 'error', protocol: PROTOCOL_VERSION, message: 'upstream is down' }, 503)}
      />,
    );
    await phase('failed:server|upstream is down');
  });

  it('does not refetch when the host passes a fresh headers object each render', async () => {
    const send = vi.fn(sending({ status: 'ok', protocol: PROTOCOL_VERSION, chart, data, truncated: false }));
    const Host = (): ReactElement => {
      const { state } = useAsk({
        endpoint: '/api/ask',
        question: 'how many',
        fetchImpl: send,
        headers: { 'x-tenant': 'acme' },
      });
      return <output data-testid="phase">{state.phase}</output>;
    };
    const view = render(<Host />);
    await phase('ok');
    view.rerender(<Host />);
    view.rerender(<Host />);
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Insight', () => {
  it('posts to the ask route the server actually listens on', async () => {
    // The server routes on the last path segment. Nothing pinned this, so react
    // shipped `${endpoint}` for ask and `${endpoint}/stream` for the feed while the
    // server was listening on `ask` and `subscribe` — two agents, no mismatch visible
    // in either suite.
    const seen: string[] = [];
    const spy: FetchLike = (input) => {
      seen.push(String(input));
      return Promise.resolve(
        reply({ status: 'ok', protocol: PROTOCOL_VERSION, chart, data, truncated: false }),
      );
    };
    render(<Insight endpoint="/api/insightkit" question="how many" fetchImpl={spy} />);
    await waitFor(() => {
      expect(seen).toContain('/api/insightkit/ask');
    });
  });

  it('trims a trailing slash on the mounted base rather than doubling it', async () => {
    const seen: string[] = [];
    const spy: FetchLike = (input) => {
      seen.push(String(input));
      return Promise.resolve(
        reply({ status: 'ok', protocol: PROTOCOL_VERSION, chart, data, truncated: false }),
      );
    };
    render(<Insight endpoint="/api/insightkit/" question="how many" fetchImpl={spy} />);
    await waitFor(() => {
      expect(seen).toContain('/api/insightkit/ask');
    });
  });

  const statuses = [
    ['ok', { status: 'ok', protocol: PROTOCOL_VERSION, chart, data, truncated: false }, 'bar'],
    [
      'unanswerable',
      { status: 'unanswerable', protocol: PROTOCOL_VERSION, message: 'no weather data' },
      'unanswerable',
    ],
    ['refused', { status: 'refused', protocol: PROTOCOL_VERSION, message: 'not allowed' }, 'refused'],
    ['error', { status: 'error', protocol: PROTOCOL_VERSION, message: 'went wrong' }, 'failed'],
  ] as const;

  for (const [name, body, marker] of statuses) {
    it(`renders ${name} distinctly`, async () => {
      const { container } = render(
        <Insight endpoint="/api/ask" question="how many" fetchImpl={sending(body)} />,
      );
      await waitFor(() => {
        expect(container.querySelector(`[data-ik-state="${marker}"]`)).not.toBeNull();
      });
    });
  }

  it('reads unanswerable as a status and a breakage as an alert', async () => {
    const view = render(
      <Insight
        endpoint="/api/ask"
        question="how many"
        fetchImpl={sending({
          status: 'unanswerable',
          protocol: PROTOCOL_VERSION,
          message: 'no weather data',
        })}
      />,
    );
    await waitFor(() => {
      expect(view.container.querySelector('[role="status"]')).not.toBeNull();
    });
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    cleanup();

    const broken = render(
      <Insight
        endpoint="/api/ask"
        question="how many"
        fetchImpl={sending({ status: 'error', protocol: PROTOCOL_VERSION, message: 'went wrong' })}
      />,
    );
    await waitFor(() => {
      expect(broken.container.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(broken.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('endpoint joining', () => {
  it('trims a long run of slashes in linear time', () => {
    // CodeQL caught /\/+$/ here, and it was genuinely quadratic rather than optimised
    // away: 16k slashes took 89ms. A loop cannot backtrack.
    const seen: string[] = [];
    const spy: FetchLike = (input) => {
      seen.push(String(input));
      return Promise.resolve(
        reply({ status: 'ok', protocol: PROTOCOL_VERSION, chart, data, truncated: false }),
      );
    };
    // The slashes must NOT be at the end: a trailing run matches immediately and is
    // fast. The quadratic case is a run the anchor can never reach.
    const hostile = `/api${'/'.repeat(50_000)}x`;
    const started = Date.now();
    render(<Insight endpoint={hostile} question="how many" fetchImpl={spy} />);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
