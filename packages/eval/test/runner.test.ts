import { describe, expect, it } from 'vitest';
import type { CaseInput, CaseOutcome, RunnerDeps } from '../src/runner.js';
import { isTransientByMessage, runCase, runCorpus } from '../src/runner.js';

const noSleep = async (): Promise<void> => {};
const one: CaseInput = { id: 'c1', tier: 'T1' };
const outcome = (status: 'PASS' | 'FAIL'): CaseOutcome => ({ status, sql: 'SELECT 1', costUsd: 0.02 });

const cases = (n: number): CaseInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, tier: 'T1' as const }));

describe('runCase', () => {
  it('passes a successful outcome through', async () => {
    const deps: RunnerDeps<CaseInput> = { run: async () => outcome('PASS'), sleep: noSleep };
    const r = await runCase(one, deps);
    expect(r.status).toBe('PASS');
    expect(r.costUsd).toBe(0.02);
  });

  it('records a genuine wrong answer as FAIL, not as an error', async () => {
    const deps: RunnerDeps<CaseInput> = { run: async () => outcome('FAIL'), sleep: noSleep };
    expect((await runCase(one, deps)).status).toBe('FAIL');
  });

  it('never retries a permanent error into a pass', async () => {
    let calls = 0;
    const deps: RunnerDeps<CaseInput> = {
      run: async () => {
        calls++;
        throw new Error('syntax error at or near "SELCT"');
      },
      sleep: noSleep,
    };
    const r = await runCase(one, deps);
    expect(r.status).toBe('INFRA_ERROR');
    expect(calls).toBe(1);
  });

  it('retries a transient error and can succeed', async () => {
    let calls = 0;
    const deps: RunnerDeps<CaseInput> = {
      run: async () => {
        calls++;
        if (calls < 3) throw new Error('429 rate limit exceeded');
        return outcome('PASS');
      },
      sleep: noSleep,
    };
    const r = await runCase(one, deps);
    expect(r.status).toBe('PASS');
    expect(calls).toBe(3);
  });

  it('gives up after the attempt budget and reports INFRA_ERROR', async () => {
    let calls = 0;
    const deps: RunnerDeps<CaseInput> = {
      run: async () => {
        calls++;
        throw new Error('upstream timeout');
      },
      sleep: noSleep,
    };
    const r = await runCase(one, deps);
    expect(r.status).toBe('INFRA_ERROR');
    expect(calls).toBe(3);
    expect(r.detail).toContain('timeout');
  });

  it('classifies transient errors by message', () => {
    expect(isTransientByMessage(new Error('HTTP 503 from provider'))).toBe(true);
    expect(isTransientByMessage(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientByMessage(new Error('column "foo" does not exist'))).toBe(false);
  });
});

describe('runCorpus', () => {
  it('runs every case when there is no cap', async () => {
    const deps: RunnerDeps<CaseInput> = { run: async () => outcome('PASS'), sleep: noSleep };
    const run = await runCorpus(cases(10), deps, { concurrency: 3 });
    expect(run.results).toHaveLength(10);
    expect(run.spendCapExceeded).toBe(false);
    expect(run.totalCostUsd).toBeCloseTo(0.2, 10);
  });

  it('stops spending once the cap is reached', async () => {
    let calls = 0;
    const deps: RunnerDeps<CaseInput> = {
      run: async () => {
        calls++;
        return outcome('PASS');
      },
      sleep: noSleep,
    };
    const run = await runCorpus(cases(20), deps, { concurrency: 2, spendCapUsd: 0.06 });
    expect(run.spendCapExceeded).toBe(true);
    expect(calls).toBeLessThanOrEqual(5);
    expect(run.results.filter((r) => r.status === 'SKIPPED_CAP').length).toBeGreaterThan(10);
  });

  it('marks skipped cases rather than dropping them from the report', async () => {
    const deps: RunnerDeps<CaseInput> = { run: async () => outcome('PASS'), sleep: noSleep };
    const run = await runCorpus(cases(8), deps, { concurrency: 1, spendCapUsd: 0.02 });
    expect(run.results).toHaveLength(8);
    expect(run.results.every((r) => r.status === 'PASS' || r.status === 'SKIPPED_CAP')).toBe(true);
  });

  it('never exceeds the requested concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const deps: RunnerDeps<CaseInput> = {
      run: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        return outcome('PASS');
      },
      sleep: noSleep,
    };
    await runCorpus(cases(20), deps, { concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('keeps results aligned with the input order', async () => {
    const deps: RunnerDeps<CaseInput> = {
      run: async (input) => ({ status: 'PASS', sql: input.id, costUsd: 0 }),
      sleep: noSleep,
    };
    const run = await runCorpus(cases(6), deps, { concurrency: 3 });
    expect(run.results.map((r) => r.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });
});
