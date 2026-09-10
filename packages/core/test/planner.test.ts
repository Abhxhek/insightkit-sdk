import { ModelError } from '@insightkit/llm';
import type { Guard } from '@insightkit/sql-guard';
import { createGuard } from '@insightkit/sql-guard';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ColumnInfo, DatabaseSchema, TableInfo } from '../src/introspect/types.js';
import { planQuery } from '../src/plan/planner.js';
import type { ModelCompletion, ModelProvider, ModelRequest } from '../src/plan/provider.js';
import { failureKind } from '../src/plan/provider.js';
import { selectTables } from '../src/plan/retrieve.js';
import type { SecurityEvent } from '../src/plan/types.js';

const col = (name: string, dataType = 'text'): ColumnInfo => ({
  name,
  dataType,
  typeOid: 25,
  nullable: true,
  comment: null,
});

const USERS: TableInfo = {
  schema: 'public',
  name: 'users',
  kind: 'table',
  comment: 'people who signed up',
  estimatedRows: 1200,
  primaryKey: ['id'],
  columns: [col('id', 'bigint'), col('email'), col('signup_method'), col('created_at', 'timestamptz')],
};

const SCHEMA: DatabaseSchema = {
  observedAs: 'ik_reader',
  tables: [USERS],
  foreignKeys: [],
  truncated: false,
};

const SELECTION = selectTables(SCHEMA, 'how many users signed up by signup method');

const draft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  answerable: true,
  reason: null,
  sql: 'SELECT signup_method AS method, count(*) AS signups FROM users GROUP BY signup_method',
  chart_kind: 'bar',
  chart_x: 'method',
  chart_y: ['signups'],
  chart_series: null,
  chart_title: 'Signups by method',
  ...over,
});

const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

type Script = readonly (unknown | ModelError)[];

function fakeProvider(script: Script) {
  const seen: ModelRequest[] = [];
  let i = 0;
  const provider: ModelProvider = {
    id: 'fake',
    model: 'fake-1',
    async complete(request: ModelRequest): Promise<ModelCompletion> {
      seen.push(request);
      const next = script[i];
      i += 1;
      if (next === undefined) throw new Error('the planner asked for more replies than were scripted');
      if (next instanceof ModelError) throw next;
      return { output: next, usage: USAGE, model: 'fake-1' };
    },
  };
  return { provider, seen };
}

let guard: Guard;
beforeAll(async () => {
  guard = await createGuard({ maxRows: 1000 });
});

const run = (script: Script, options = {}) => {
  const f = fakeProvider(script);
  return { ...f, result: planQuery({ guard, provider: f.provider }, 'how many users', SELECTION, options) };
};

describe('turning a question into a plan', () => {
  it('returns an approved query and a chart', async () => {
    const { result } = run([draft()]);
    const r = await result;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.chart).toEqual({
      kind: 'bar',
      x: 'method',
      y: ['signups'],
      series: null,
      title: 'Signups by method',
    });
    expect(r.plan.tables.map((t) => t.name)).toContain('users');
  });

  it('carries the guard re-emitted SQL, not what the model wrote', async () => {
    const { result } = run([draft()]);
    const r = await result;
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.sql).toMatch(/LIMIT 1000/);
    expect(r.plan.sql).not.toBe(draft().sql);
  });

  it('puts the question in a user turn rather than in our instructions', async () => {
    const { seen, result } = run([draft()]);
    await result;
    expect(seen[0]?.system).not.toContain('how many users');
    expect(seen[0]?.messages[0]).toEqual({ role: 'user', content: 'how many users' });
  });

  it('describes only the tables retrieval chose', async () => {
    const { seen, result } = run([draft()]);
    await result;
    expect(seen[0]?.system).toContain('CREATE TABLE public.users');
    expect(seen[0]?.system).toContain('people who signed up');
  });

  it('sums usage across the whole plan', async () => {
    const { result } = run([draft()]);
    const r = await result;
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.usage.inputTokens).toBe(100);
    expect(r.plan.attempts).toHaveLength(1);
  });
});

describe('when the schema cannot answer', () => {
  it('reports the reason instead of inventing a query', async () => {
    const { seen, result } = run([
      draft({ answerable: false, reason: 'there is no weather data in this schema', sql: null }),
    ]);
    const r = await result;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unanswerable');
    expect(r.detail).toContain('weather');
    expect(seen).toHaveLength(1);
  });

  it('does not pass off a self-contradicting plan as a considered refusal', async () => {
    // answerable with no SQL is the model contradicting itself. Reporting that as
    // "the schema cannot answer this" would tell the user something untrue.
    const r = await run([draft({ sql: null })]).result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('invalid_plan');
      expect(r.detail).toContain('answerable');
    }
  });
});

describe('repairing an honest mistake', () => {
  it('feeds the guard verdict back and accepts the corrected query', async () => {
    const { seen, result } = run([
      draft({ sql: "SELECT pg_read_file('/etc/passwd') AS leak FROM users" }),
      draft(),
    ]);
    const r = await result;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.attempts.map((a) => a.outcome)).toEqual(['denied', 'approved']);
    expect(r.plan.attempts[0]?.code).toBe('E_FUNCTION_NOT_ALLOWED');
    expect(r.plan.usage.inputTokens).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it('tells the model why, without echoing the user back at it', async () => {
    const { seen, result } = run([draft({ sql: 'SELECT * FRM users' }), draft()]);
    await result;
    const repair = seen[1]?.messages.at(-1);
    expect(repair?.role).toBe('user');
    expect(repair?.content).toContain('rejected by the safety check');
    expect(repair?.content).not.toContain('how many users');
  });

  it('gives up once the attempts are spent', async () => {
    const bad = draft({ sql: "SELECT pg_read_file('/etc/passwd') AS leak FROM users" });
    const { seen, result } = run([bad, bad], { maxAttempts: 2 });
    const r = await result;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rejected');
    expect(r.code).toBe('E_FUNCTION_NOT_ALLOWED');
    expect(seen).toHaveLength(2);
  });

  it('does not retry at all when told not to', async () => {
    const { seen, result } = run([draft({ sql: 'SELECT * FRM users' })], { maxAttempts: 1 });
    await result;
    expect(seen).toHaveLength(1);
  });
});

describe('when the denial is not a mistake', () => {
  const write = draft({ sql: 'DELETE FROM users' });

  it('stops immediately rather than handing an attacker another attempt', async () => {
    const { seen, result } = run([write, draft()], { maxAttempts: 3 });
    const r = await result;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('E_NOT_SELECT');
    expect(seen).toHaveLength(1);
  });

  it('raises a security event carrying what was attempted', async () => {
    const events: SecurityEvent[] = [];
    await run([write], { onSecurityEvent: (e: SecurityEvent) => events.push(e) }).result;
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe('E_NOT_SELECT');
    expect(events[0]?.sql).toBe('DELETE FROM users');
    expect(events[0]?.question).toBe('how many users');
  });

  it('raises nothing for an ordinary rejection', async () => {
    const events: SecurityEvent[] = [];
    await run([draft({ sql: 'SELECT * FRM users' })], {
      maxAttempts: 1,
      onSecurityEvent: (e: SecurityEvent) => events.push(e),
    }).result;
    expect(events).toEqual([]);
  });

  it('does not let a failing host logger fail the request', async () => {
    const r = await run([write], {
      onSecurityEvent: () => {
        throw new Error('the host logger is down');
      },
    }).result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('E_NOT_SELECT');
  });

  it('stops on stacked statements too', async () => {
    const { seen, result } = run([draft({ sql: 'SELECT 1; DROP TABLE users' }), draft()]);
    const r = await result;
    if (r.ok) throw new Error('expected a rejection');
    expect(r.code).toBe('E_MULTI_STATEMENT');
    expect(seen).toHaveLength(1);
  });
});

describe('when the model itself fails', () => {
  it('reports a truncated reply as a model error rather than a bad query', async () => {
    const r = await run([new ModelError('truncated', 'the response reached the limit')]).result;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('model_error');
    expect(r.detail).toContain('truncated');
  });

  it('rejects an object that is not a plan', async () => {
    const r = await run([{ nonsense: true }]).result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_plan');
  });

  it('rejects a non-object entirely', async () => {
    const r = await run(['SELECT 1']).result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_plan');
  });
});

describe('the seam between core and a real provider', () => {
  it('accepts a provider built by @insightkit/llm without core importing it', async () => {
    // core declares ModelProvider structurally so it takes on no dependency to reach a
    // model. That only holds while a real adapter still satisfies the shape, which is
    // a compile-time claim this makes at runtime too.
    const { anthropicProvider } = await import('@insightkit/llm/anthropic');
    const real: ModelProvider = anthropicProvider({ apiKey: 'sk-test-key', model: 'claude-opus-5' });
    expect(real.id).toBe('anthropic');
    expect(typeof real.complete).toBe('function');
  });

  it('reads the failure kind off a real ModelError without knowing the class', () => {
    expect(failureKind(new ModelError('truncated', 'x'))).toBe('truncated');
    expect(failureKind(new Error('plain'))).toBeNull();
    expect(failureKind(null)).toBeNull();
  });
});
