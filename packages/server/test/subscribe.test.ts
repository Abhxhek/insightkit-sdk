import { parseStreamEvent } from '@insightkit/protocol';
import { describe, expect, it } from 'vitest';
import { createInsightKit } from '../src/insightkit.js';
import type { InsightKitConfig, InsightKitServer, LiveConfig } from '../src/types.js';
import {
  askRequest,
  draft,
  fakeDatabase,
  fakeGuard,
  fakeProvider,
  fakeResolver,
  SCHEMA,
  scopeFor,
  subscribeRequest,
  TENANT,
} from './fake.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const FAST: LiveConfig = { minIntervalMs: 20, defaultIntervalMs: 20, keepaliveMs: 1_000 };

interface Harness {
  readonly ik: InsightKitServer;
  readonly database: ReturnType<typeof fakeDatabase>;
  readonly model: ReturnType<typeof fakeProvider>;
  readonly token: () => Promise<string>;
}

function harness(
  over: Partial<InsightKitConfig> = {},
  results?: readonly (readonly (readonly unknown[])[])[],
): Harness {
  const database = fakeDatabase(results === undefined ? {} : { results });
  const model = fakeProvider([draft()]);
  const config: InsightKitConfig = {
    source: database.source,
    guard: fakeGuard(),
    provider: model.provider,
    schema: SCHEMA,
    tenancy: { mode: 'multi', resolve: fakeResolver({ good: scopeFor(TENANT), other: scopeFor('other') }) },
    live: FAST,
    ...over,
  };
  const ik = createInsightKit(config);
  return {
    ik,
    database,
    model,
    async token() {
      const answer = (await (await ik.ask(askRequest('how many users', 'good'))).json()) as {
        stream?: string;
      };
      if (answer.stream === undefined) throw new Error('the ask did not issue a stream token');
      return answer.stream;
    },
  };
}

async function* frames(response: Response): AsyncGenerator<Record<string, unknown>> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      buffer += decoder.decode(next.value, { stream: true });
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const chunk = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) yield JSON.parse(line.slice(6)) as Record<string, unknown>;
        }
        at = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const drain = async (response: Response, limit = 50): Promise<Record<string, unknown>[]> => {
  const out: Record<string, unknown>[] = [];
  for await (const frame of frames(response)) {
    out.push(frame);
    if (out.length >= limit) break;
  }
  return out;
};

describe('subscribing to an approved query', () => {
  it('emits a snapshot and closes with a reason when the subscription expires', async () => {
    const h = harness({ live: { ...FAST, maxDurationMs: 60 } }, [
      [['email', 3]],
      [['email', 4]],
      [['email', 5]],
    ]);
    const token = await h.token();

    const response = await h.ik.subscribe(subscribeRequest(token, 'good'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const collected = await drain(response);
    for (const frame of collected) expect(parseStreamEvent(frame).ok).toBe(true);

    const snapshots = collected.filter((f) => f.type === 'snapshot');
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    // The ask read rows first, so the stream carries what the table says now, not a replay.
    expect(snapshots[0]?.data).toEqual({ columns: ['method', 'signups'], rows: [['email', 4]] });
    expect(snapshots[1]?.data).toEqual({ columns: ['method', 'signups'], rows: [['email', 5]] });
    expect(snapshots[0]?.at).toBeTypeOf('string');
    expect(collected.at(-1)).toEqual({ type: 'closed', protocol: 1, reason: 'expired' });
  });

  it('never calls the model again, however many snapshots it sends', async () => {
    const h = harness({ live: { ...FAST, maxDurationMs: 80 } });
    const token = await h.token();
    expect(h.model.seen).toHaveLength(1);

    const collected = await drain(await h.ik.subscribe(subscribeRequest(token, 'good')));

    expect(collected.filter((f) => f.type === 'snapshot').length).toBeGreaterThan(1);
    expect(h.model.seen).toHaveLength(1);
  });

  it('runs the same approved sql each time, with the tenant setting re-applied', async () => {
    const h = harness({ live: { ...FAST, maxDurationMs: 60 } });
    const token = await h.token();
    await drain(await h.ik.subscribe(subscribeRequest(token, 'good')));

    const reads = h.database.statements.filter((s) => s.startsWith('SELECT'));
    expect(reads.length).toBeGreaterThan(1);
    expect(new Set(reads).size).toBe(1);
    const scoped = h.database.statements.filter((s) => s === "SET LOCAL app.tenant_id = 'acme'");
    expect(scoped.length).toBe(reads.length);
  });

  it('stops querying when the client goes away', async () => {
    const h = harness();
    const token = await h.token();

    const aborter = new AbortController();
    const response = await h.ik.subscribe(
      new Request('http://host.test/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
        body: JSON.stringify({ token }),
        signal: aborter.signal,
      }),
    );

    const body = response.body;
    expect(body).not.toBeNull();
    if (body === null) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"snapshot"')) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }

    const before = h.database.reads();
    aborter.abort();
    await delay(120);

    expect(h.database.reads()).toBe(before);
    const after = await reader.read();
    expect(after.done).toBe(true);
  });

  it('closes every live stream with shutdown when the server closes', async () => {
    const h = harness();
    const token = await h.token();
    const response = await h.ik.subscribe(subscribeRequest(token, 'good'));

    const seen: Record<string, unknown>[] = [];
    const reading = (async () => {
      for await (const frame of frames(response)) {
        seen.push(frame);
        if (frame.type === 'closed') break;
      }
    })();

    await delay(60);
    await h.ik.close();
    await reading;

    expect(seen.at(-1)).toEqual({ type: 'closed', protocol: 1, reason: 'shutdown' });
  });

  it('clamps the interval to the server floor, whatever the client asked for', async () => {
    const h = harness({ live: { minIntervalMs: 5_000, defaultIntervalMs: 5_000, maxDurationMs: 200 } });
    const token = await h.token();

    const response = await h.ik.subscribe(subscribeRequest(token, 'good', 1_000));
    const body = response.body;
    if (body === null) throw new Error('no stream');
    const reader = body.getReader();
    const first = await reader.read();
    await reader.cancel();

    expect(new TextDecoder().decode(first.value)).toContain('retry: 5000');
  });

  it("answers the same way for an unknown token and for somebody else's", async () => {
    const h = harness();
    const token = await h.token();

    const unknown = await drain(await h.ik.subscribe(subscribeRequest('f'.repeat(64), 'good')));
    const foreign = await drain(await h.ik.subscribe(subscribeRequest(token, 'other')));

    expect(unknown).toEqual([{ type: 'closed', protocol: 1, reason: 'expired' }]);
    expect(foreign).toEqual([{ type: 'closed', protocol: 1, reason: 'expired' }]);
    expect(h.database.statements.filter((s) => s.startsWith('SELECT'))).toHaveLength(1);
  });

  it('replaces an earlier stream on the same token rather than doubling the load', async () => {
    const h = harness();
    const token = await h.token();

    const first = await h.ik.subscribe(subscribeRequest(token, 'good'));
    const firstFrames = drain(first);
    await delay(40);
    const second = await h.ik.subscribe(subscribeRequest(token, 'good'));

    const collected = await firstFrames;
    expect(collected.at(-1)).toEqual({ type: 'closed', protocol: 1, reason: 'replaced' });

    await h.ik.close();
    await drain(second).catch(() => undefined);
  });

  it('refuses to subscribe without a token in multi-tenant mode', async () => {
    const h = harness();
    const token = await h.token();
    const response = await h.ik.subscribe(subscribeRequest(token));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    const problem = (await response.json()) as Record<string, unknown>;
    expect(parseStreamEvent(problem).ok).toBe(true);
  });

  it('answers 503 when the host did not enable live updates', async () => {
    const h = harness({ live: false });
    const answer = (await (await h.ik.ask(askRequest('how many users', 'good'))).json()) as {
      stream?: string;
    };
    expect(answer.stream).toBeUndefined();
    expect((await h.ik.subscribe(subscribeRequest('x'.repeat(16), 'good'))).status).toBe(503);
  });

  it('caps concurrent streams for one identity', async () => {
    const h = harness({ live: { ...FAST, maxPerIdentity: 1 } });
    const token = await h.token();

    const first = await h.ik.subscribe(subscribeRequest(token, 'good'));
    const reading = drain(first);
    await delay(30);
    const second = await h.ik.subscribe(subscribeRequest(token, 'good'));

    expect(second.status).toBe(429);
    await h.ik.close();
    await reading;
  });
});
