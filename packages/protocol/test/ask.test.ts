import { describe, expect, it } from 'vitest';
import type { AskOkResponse, AskResponse } from '../src/index.js';
import {
  MAX_QUESTION_LENGTH,
  PROTOCOL_VERSION,
  parseAskRequest,
  parseAskResponse,
  protocolVersionOf,
} from '../src/index.js';

const chart = { kind: 'bar', x: 'signup_method', y: ['users'], series: null, title: 'Signups' };
const data = { columns: ['signup_method', 'users'], rows: [['google', 12]] };

const ok = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'ok',
  protocol: PROTOCOL_VERSION,
  chart,
  data,
  truncated: false,
  ...over,
});

const prose = (status: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status,
  protocol: PROTOCOL_VERSION,
  message: 'there is no weather data in this schema',
  ...over,
});

describe('ask request', () => {
  it('parses a question and hands back the trimmed text', () => {
    const parsed = parseAskRequest({ question: '  how many users joined this week?  ' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.question).toBe('how many users joined this week?');
  });

  it('rejects empty and whitespace-only questions', () => {
    expect(parseAskRequest({ question: '' }).ok).toBe(false);
    expect(parseAskRequest({ question: '   ' }).ok).toBe(false);
    expect(parseAskRequest({ question: ' \t\n\r ' }).ok).toBe(false);
  });

  it('caps the question at the boundary, measured after trimming', () => {
    expect(parseAskRequest({ question: 'a' }).ok).toBe(true);
    expect(parseAskRequest({ question: 'a'.repeat(MAX_QUESTION_LENGTH) }).ok).toBe(true);
    expect(parseAskRequest({ question: 'a'.repeat(MAX_QUESTION_LENGTH + 1) }).ok).toBe(false);
    expect(parseAskRequest({ question: `   ${'a'.repeat(MAX_QUESTION_LENGTH)}   ` }).ok).toBe(true);
  });

  it('rejects control characters but keeps tab, newline and carriage return', () => {
    for (const bad of ['\u0000', '\u0007', '\u001B[31m', '\u007F', '\u0085', '\u009B']) {
      expect(parseAskRequest({ question: `revenue ${bad} by month` }).ok).toBe(false);
    }
    expect(parseAskRequest({ question: 'revenue\tby\nmonth\r\nsplit by plan' }).ok).toBe(true);
  });

  it('rejects a missing, non-string or extra field', () => {
    expect(parseAskRequest({}).ok).toBe(false);
    expect(parseAskRequest({ question: 42 }).ok).toBe(false);
    expect(parseAskRequest({ question: null }).ok).toBe(false);
    expect(parseAskRequest('how many users?').ok).toBe(false);
    const extra = parseAskRequest({ question: 'how many users?', maxRows: 100000 });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error).toContain('maxRows');
  });

  it('reports rather than throws, and locates the problem', () => {
    const parsed = parseAskRequest({ question: '' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues[0]?.path).toBe('question');
      expect(parsed.error).toContain('question');
    }
  });
});

describe('ask response', () => {
  it('parses a valid response of each status', () => {
    for (const sample of [ok(), prose('unanswerable'), prose('refused'), prose('error')]) {
      const parsed = parseAskResponse(sample);
      expect(parsed.ok, JSON.stringify(sample)).toBe(true);
    }
  });

  it('carries the protocol version on every variant', () => {
    for (const sample of [ok(), prose('unanswerable'), prose('refused'), prose('error')]) {
      const parsed = parseAskResponse(sample);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.protocol).toBe(PROTOCOL_VERSION);

      const { protocol: _dropped, ...withoutVersion } = sample;
      expect(parseAskResponse(withoutVersion).ok).toBe(false);
      expect(parseAskResponse({ ...sample, protocol: PROTOCOL_VERSION + 1 }).ok).toBe(false);
    }
  });

  it('survives the JSON round trip the wire actually performs', () => {
    for (const sample of [ok({ sql: 'SELECT 1' }), prose('refused')]) {
      expect(parseAskResponse(JSON.parse(JSON.stringify(sample))).ok).toBe(true);
    }
  });

  it('treats sql as opt-in rather than required', () => {
    expect(parseAskResponse(ok()).ok).toBe(true);
    const parsed = parseAskResponse(ok({ sql: 'SELECT signup_method, count(*) FROM users GROUP BY 1' }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.status === 'ok') expect(parsed.value.sql).toContain('GROUP BY');
  });

  it('rejects a response carrying fields from another branch', () => {
    expect(parseAskResponse(prose('refused', { truncated: false })).ok).toBe(false);
    expect(parseAskResponse(prose('unanswerable', { data })).ok).toBe(false);
    expect(parseAskResponse(ok({ message: 'something went wrong' })).ok).toBe(false);
    expect(parseAskResponse(ok({ status: 'error' })).ok).toBe(false);
  });

  it('never lets a deny code through as an unknown key', () => {
    for (const leak of [
      prose('refused', { code: 'E_NOT_SELECT' }),
      prose('refused', { denyCode: 'E_MULTI_STATEMENT' }),
      ok({ attempts: [{ n: 1, code: 'E_NOT_SELECT' }] }),
      ok({ usage: { inputTokens: 900, outputTokens: 40 } }),
      ok({ model: 'claude-opus-5' }),
    ]) {
      const parsed = parseAskResponse(leak);
      expect(parsed.ok, JSON.stringify(leak)).toBe(false);
    }
    const parsed = parseAskResponse(prose('refused', { code: 'E_NOT_SELECT' }));
    if (!parsed.ok) expect(parsed.error).toContain('code');
  });

  it('rejects an unknown status and a missing message', () => {
    expect(parseAskResponse({ status: 'denied', protocol: PROTOCOL_VERSION, message: 'no' }).ok).toBe(false);
    expect(parseAskResponse({ protocol: PROTOCOL_VERSION, message: 'no' }).ok).toBe(false);
    expect(parseAskResponse(prose('error', { message: '' })).ok).toBe(false);
    expect(parseAskResponse(prose('error', { message: '   ' })).ok).toBe(false);
  });

  it('rejects a message carrying a terminal escape', () => {
    expect(parseAskResponse(prose('error', { message: 'failed \u001B[2J' })).ok).toBe(false);
  });

  it('rejects a truncated flag that is not a boolean', () => {
    expect(parseAskResponse(ok({ truncated: 'yes' })).ok).toBe(false);
    const { truncated: _dropped, ...withoutFlag } = ok();
    expect(parseAskResponse(withoutFlag).ok).toBe(false);
  });
});

describe('protocol version', () => {
  it('is readable from a response this bundle cannot parse', () => {
    expect(protocolVersionOf({ status: 'ok', protocol: 2 })).toBe(2);
    expect(protocolVersionOf(ok())).toBe(PROTOCOL_VERSION);
  });

  it('is null when there is nothing version-shaped to read', () => {
    expect(protocolVersionOf(null)).toBe(null);
    expect(protocolVersionOf('ok')).toBe(null);
    expect(protocolVersionOf({})).toBe(null);
    expect(protocolVersionOf({ protocol: '1' })).toBe(null);
    expect(protocolVersionOf({ protocol: 1.5 })).toBe(null);
  });
});

const narrowed = (response: AskResponse): string =>
  response.status === 'ok' ? response.data.columns.join(',') : response.message;
void narrowed;

const _okHasNoMessage: 'message' extends keyof AskOkResponse ? never : true = true;
void _okHasNoMessage;
