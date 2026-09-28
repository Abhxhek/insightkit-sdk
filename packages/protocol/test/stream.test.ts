import { describe, expect, it } from 'vitest';
import { parseAskResponse } from '../src/ask.js';
import {
  MAX_STREAM_INTERVAL_MS,
  MIN_STREAM_INTERVAL_MS,
  parseStreamEvent,
  parseSubscribeRequest,
} from '../src/stream.js';
import { PROTOCOL_VERSION } from '../src/version.js';

const snapshot = {
  type: 'snapshot',
  protocol: PROTOCOL_VERSION,
  data: { columns: ['day', 'n'], rows: [['2026-09-29', 4]] },
  truncated: false,
  at: '2026-09-29T10:00:00.000Z',
};

describe('subscribing', () => {
  it('accepts a server-issued token', () => {
    expect(parseSubscribeRequest({ token: 'abc' }).ok).toBe(true);
  });

  it('refuses a subscription that names a query instead of a token', () => {
    const r = parseSubscribeRequest({ token: 'abc', sql: 'SELECT 1' });
    expect(r.ok).toBe(false);
  });

  it('clamps the interval at both ends rather than trusting a client', () => {
    expect(parseSubscribeRequest({ token: 'a', intervalMs: MIN_STREAM_INTERVAL_MS - 1 }).ok).toBe(false);
    expect(parseSubscribeRequest({ token: 'a', intervalMs: MAX_STREAM_INTERVAL_MS + 1 }).ok).toBe(false);
    expect(parseSubscribeRequest({ token: 'a', intervalMs: 5_000 }).ok).toBe(true);
  });

  it('refuses an empty or oversized token', () => {
    expect(parseSubscribeRequest({ token: '' }).ok).toBe(false);
    expect(parseSubscribeRequest({ token: 'x'.repeat(513) }).ok).toBe(false);
  });
});

describe('stream events', () => {
  it('parses a snapshot', () => {
    expect(parseStreamEvent(snapshot).ok).toBe(true);
  });

  it('carries no chart, because a subscription never re-plans', () => {
    const r = parseStreamEvent({
      ...snapshot,
      chart: { kind: 'bar', x: null, y: [], series: null, title: null },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a Date on the wire, as everywhere else', () => {
    expect(parseStreamEvent({ ...snapshot, at: new Date() }).ok).toBe(false);
  });

  it('reports why a stream closed, from a fixed set', () => {
    expect(parseStreamEvent({ type: 'closed', protocol: PROTOCOL_VERSION, reason: 'expired' }).ok).toBe(true);
    expect(parseStreamEvent({ type: 'closed', protocol: PROTOCOL_VERSION, reason: 'because' }).ok).toBe(
      false,
    );
  });

  it('keeps an error generic and carries no deny code', () => {
    const ok = parseStreamEvent({ type: 'error', protocol: PROTOCOL_VERSION, message: 'the query failed' });
    expect(ok.ok).toBe(true);
    const leaky = parseStreamEvent({
      type: 'error',
      protocol: PROTOCOL_VERSION,
      message: 'nope',
      code: 'E_NOT_SELECT',
    });
    expect(leaky.ok).toBe(false);
  });
});

describe('the token reaches the client on the answer', () => {
  const ok = {
    status: 'ok',
    protocol: PROTOCOL_VERSION,
    chart: { kind: 'number', x: null, y: ['n'], series: null, title: null },
    data: { columns: ['n'], rows: [[1]] },
    truncated: false,
  };

  it('is optional, so a host that does not stream sends nothing', () => {
    expect(parseAskResponse(ok).ok).toBe(true);
  });

  it('is accepted when present', () => {
    expect(parseAskResponse({ ...ok, stream: 'tok_123' }).ok).toBe(true);
  });

  it('is still rejected when empty', () => {
    expect(parseAskResponse({ ...ok, stream: '' }).ok).toBe(false);
  });
});
