import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createInsightKit } from '../src/insightkit.js';
import { askRequest, draft, fakeDatabase, fakeProvider, singleTenantConfig } from './fake.js';

const DENY_CODES = [
  'E_PARSE',
  'E_EMPTY',
  'E_NUL_BYTE',
  'E_MULTI_STATEMENT',
  'E_NOT_SELECT',
  'E_NODE_NOT_ALLOWED',
  'E_FIELD_NOT_ALLOWED',
  'E_FUNCTION_NOT_ALLOWED',
  'E_SCHEMA_NOT_ALLOWED',
  'E_TABLE_NOT_ALLOWED',
  'E_DEPTH_EXCEEDED',
  'E_LIMIT_NOT_STATIC',
  'E_LIMIT_NOT_ENFORCEABLE',
  'E_ROUND_TRIP_FAILED',
  'E_INTERNAL',
];

const INTERNALS = ['attempts', 'usage', 'inputTokens', 'outputTokens', 'fake-1', 'reason'];

const serialised = async (script: readonly unknown[], over = {}): Promise<string> => {
  const ik = createInsightKit(singleTenantConfig(over, { script }));
  const response = await ik.ask(askRequest('how many users signed up'));
  return JSON.stringify(await response.json());
};

const assertClean = (text: string): void => {
  for (const code of DENY_CODES) expect(text).not.toContain(code);
  for (const word of INTERNALS) expect(text).not.toContain(word);
  expect(text).not.toContain('SELECT');
  expect(text).not.toContain('users');
};

describe('what never crosses the wire', () => {
  it('drops the deny code from a rejected plan', async () => {
    assertClean(await serialised([draft({ sql: 'DELETE FROM users WHERE 1=1' })]));
  });

  it('drops the deny code from a repairable denial that ran out of attempts', async () => {
    const script = [
      draft({ sql: 'SELECT pg_sleep(10) FROM users' }),
      draft({ sql: 'SELECT pg_sleep(9) FROM users' }),
    ];
    assertClean(await serialised(script));
  });

  it('drops the deny code an unanswerable plan echoed back from a repair turn', async () => {
    const script = [
      draft({ sql: 'SELECT pg_sleep(10) FROM users' }),
      draft({
        answerable: false,
        sql: null,
        reason: 'the safety check said E_FUNCTION_NOT_ALLOWED: function pg_sleep is not on the allowlist',
      }),
    ];
    const text = await serialised(script);
    assertClean(text);
    expect(text).toContain('the data available cannot answer that question');
  });

  it('drops the provider detail from a model error', async () => {
    const failure = Object.assign(new Error('anthropic returned 429 for key sk-ant-secret'), {
      kind: 'rate_limit',
    });
    const text = await serialised([failure]);
    expect(text).not.toContain('sk-ant');
    expect(text).not.toContain('rate_limit');
    expect(text).not.toContain('anthropic');
  });

  it('drops the driver detail from a thrown read', async () => {
    const ik = createInsightKit(
      singleTenantConfig({}, { database: fakeDatabase({ failReads: true }), script: [draft()] }),
    );
    const text = JSON.stringify(await (await ik.ask(askRequest('how many users'))).json());
    expect(text).not.toContain('permission denied');
    expect(text).not.toContain('relation');
  });

  it('keeps an unvalidatable response off the wire as a 500', async () => {
    const database = fakeDatabase({ results: [[[new Date('2026-09-05T00:00:00Z'), 1]]] });
    const ik = createInsightKit(singleTenantConfig({}, { database, script: [draft()] }));
    const response = await ik.ask(askRequest('how many users'));
    expect(response.status).toBe(200);
    const payload = JSON.parse(await response.text()) as { status: string };
    expect(payload.status).toBe('error');
  });

  it('never reports a model failure as a refusal', async () => {
    const model = fakeProvider([{ not: 'a plan' }]);
    const ik = createInsightKit(singleTenantConfig({}, { provider: model }));
    const answer = (await (await ik.ask(askRequest('how many users'))).json()) as { status: string };
    expect(answer.status).toBe('error');
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const srcFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? srcFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );

describe('the one call site', () => {
  it('reaches runGuardedRead from scope.ts and nowhere else', () => {
    const callers = srcFiles(join(here, '..', 'src'))
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes('runGuardedRead('));
    expect(callers.map((file) => file.split('/').slice(-1)[0])).toEqual(['scope.ts']);
  });
});
