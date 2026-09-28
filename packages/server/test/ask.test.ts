import { defineGlossary } from '@insightkit/core';
import { PROTOCOL_VERSION, parseAskResponse } from '@insightkit/protocol';
import { describe, expect, it } from 'vitest';
import { createInsightKit } from '../src/insightkit.js';
import type { ServerError, ServerSecurityEvent } from '../src/types.js';
import { askRequest, draft, fakeDatabase, fakeProvider, singleTenantConfig } from './fake.js';

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe('asking a question', () => {
  it('returns a response the protocol accepts', async () => {
    const ik = createInsightKit(singleTenantConfig());
    const response = await ik.ask(askRequest('how many users by signup method'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const parsed = parseAskResponse(await body(response));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.status).toBe('ok');
    if (parsed.value.status !== 'ok') return;
    expect(parsed.value.protocol).toBe(PROTOCOL_VERSION);
    expect(parsed.value.chart).toEqual({
      kind: 'bar',
      x: 'method',
      y: ['signups'],
      series: null,
      title: 'Signups by method',
    });
    expect(parsed.value.data).toEqual({ columns: ['method', 'signups'], rows: [['email', 3]] });
    expect(parsed.value.sql).toBeUndefined();
    expect(parsed.value.stream).toBeUndefined();
  });

  it('returns the approved sql only when the host opted in', async () => {
    const ik = createInsightKit(singleTenantConfig({ exposeSql: true }));
    const answer = await body(await ik.ask(askRequest('how many users')));
    expect(answer.sql).toBe(
      'SELECT signup_method AS method, count(*) AS signups FROM users GROUP BY signup_method LIMIT 1000',
    );
  });

  it('refuses a question that is not a question before the model is reached', async () => {
    const model = fakeProvider([]);
    const ik = createInsightKit(singleTenantConfig({}, { provider: model }));

    const empty = await ik.ask(askRequest(''));
    const oversized = await ik.ask(askRequest('x'.repeat(2001)));
    const missing = await ik.ask(
      new Request('http://host.test/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questions: 'typo' }),
      }),
    );

    expect([empty.status, oversized.status, missing.status]).toEqual([400, 400, 400]);
    expect(model.seen).toHaveLength(0);
  });

  it('refuses a body that is not json, and one that is too large', async () => {
    const model = fakeProvider([]);
    const ik = createInsightKit(singleTenantConfig({ limits: { maxBodyBytes: 64 } }, { provider: model }));

    const wrongType = await ik.ask(
      new Request('http://host.test/ask', { method: 'POST', body: 'question=hi' }),
    );
    const tooBig = await ik.ask(askRequest('y'.repeat(500)));

    expect(wrongType.status).toBe(415);
    expect(tooBig.status).toBe(413);
    expect(model.seen).toHaveLength(0);
  });

  it('refuses anything but POST', async () => {
    const ik = createInsightKit(singleTenantConfig());
    const response = await ik.ask(new Request('http://host.test/ask', { method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('carries the model reason on an unanswerable plan', async () => {
    const ik = createInsightKit(
      singleTenantConfig(
        {},
        { script: [draft({ answerable: false, sql: null, reason: 'no weather table exists' })] },
      ),
    );
    const answer = await body(await ik.ask(askRequest('what is the weather')));
    expect(answer.status).toBe('unanswerable');
    expect(answer.message).toBe('no weather table exists');
  });

  it('answers 200 for a refusal, so the status code is not an oracle', async () => {
    const ik = createInsightKit(singleTenantConfig({}, { script: [draft({ sql: 'DELETE FROM users' })] }));
    const response = await ik.ask(askRequest('drop everything'));
    expect(response.status).toBe(200);
    expect((await body(response)).status).toBe('refused');
  });

  it('turns a read failure into a generic error and tells the host', async () => {
    const errors: ServerError[] = [];
    const ik = createInsightKit(
      singleTenantConfig(
        { onError: (error) => errors.push(error) },
        { database: fakeDatabase({ failReads: true }) },
      ),
    );

    const response = await ik.ask(askRequest('how many users'));
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(answer.status).toBe('error');
    expect(JSON.stringify(answer)).not.toContain('permission denied');
    expect(errors.map((e) => e.phase)).toContain('read');
  });

  it('routes on the last path segment', async () => {
    const ik = createInsightKit(singleTenantConfig());
    const ok = await ik.handler(askRequest('how many users'));
    const missing = await ik.handler(new Request('http://host.test/api/insightkit/nope', { method: 'POST' }));
    expect(ok.status).toBe(200);
    expect(missing.status).toBe(404);
  });
});

describe('security events', () => {
  const attack = [draft({ sql: 'SELECT 1; DROP TABLE users' })];

  it('reaches the host callback with the identity attached', async () => {
    const events: ServerSecurityEvent[] = [];
    const ik = createInsightKit(
      singleTenantConfig({ onSecurityEvent: (event) => events.push(event) }, { script: attack }),
    );

    const response = await ik.ask(askRequest('give me everything'));
    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe('E_MULTI_STATEMENT');
    expect(events[0]?.identity).toBe('single-tenant');
    expect(events[0]?.throttled).toBe(false);
  });

  it('does not fail the request when the host callback throws', async () => {
    const ik = createInsightKit(
      singleTenantConfig(
        {
          onSecurityEvent: () => {
            throw new Error('the host logger is down');
          },
        },
        { script: attack },
      ),
    );

    const response = await ik.ask(askRequest('give me everything'));
    expect(response.status).toBe(200);
    expect((await body(response)).status).toBe('refused');
  });

  it('throttles an identity that keeps probing', async () => {
    const events: ServerSecurityEvent[] = [];
    const ik = createInsightKit(
      singleTenantConfig(
        {
          onSecurityEvent: (event) => events.push(event),
          limits: { securityStrikes: 2, questionsPerMinute: 600, burst: 100 },
        },
        { script: [...attack, ...attack, ...attack] },
      ),
    );

    const first = await ik.ask(askRequest('probe one'));
    const second = await ik.ask(askRequest('probe two'));
    const third = await ik.ask(askRequest('probe three'));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(events[1]?.throttled).toBe(true);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).not.toBeNull();
  });
});

describe('load controls', () => {
  it('rejects a burst from one identity with 429', async () => {
    const ik = createInsightKit(
      singleTenantConfig({ limits: { burst: 1, questionsPerMinute: 1 } }, { script: [draft(), draft()] }),
    );

    const first = await ik.ask(askRequest('how many users'));
    const second = await ik.ask(askRequest('how many users'));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    const answer = await body(second);
    expect(answer.status).toBe('error');
  });
});

describe('the glossary', () => {
  it('reaches the prompt when every entry resolves', async () => {
    const model = fakeProvider([draft()]);
    const ik = createInsightKit(
      singleTenantConfig(
        {
          glossary: defineGlossary([
            {
              term: 'signup method',
              definition: 'how somebody first arrived',
              refs: [{ schema: 'public', table: 'users', columns: ['signup_method'] }],
            },
          ]),
        },
        { provider: model },
      ),
    );

    expect((await ik.checkGlossary())?.ok).toBe(true);
    await ik.ask(askRequest('how many users by signup method'));
    expect(model.seen[0]?.system).toContain('how somebody first arrived');
  });

  it('drops an entry naming a column that is not there, and tells the host', async () => {
    const errors: ServerError[] = [];
    const model = fakeProvider([draft()]);
    const ik = createInsightKit(
      singleTenantConfig(
        {
          onError: (error) => errors.push(error),
          glossary: defineGlossary([
            {
              term: 'churn',
              definition: 'customers who left',
              refs: [{ schema: 'public', table: 'users', columns: ['cancelled_at'] }],
            },
          ]),
        },
        { provider: model },
      ),
    );

    const report = await ik.checkGlossary();
    expect(report?.ok).toBe(false);

    await ik.ask(askRequest('how much churn'));
    expect(model.seen[0]?.system).not.toContain('customers who left');
    expect(errors.some((e) => String(e.error).includes('unknown_column'))).toBe(true);
  });
});
