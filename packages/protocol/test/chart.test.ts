import { describe, expect, it } from 'vitest';
import type { ChartSpec } from '../src/index.js';
import { CHART_KINDS, chartSpecSchema, parseChartSpec } from '../src/index.js';

const spec = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  kind: 'bar',
  x: 'signup_method',
  y: ['users'],
  series: null,
  title: 'Users by signup method',
  ...over,
});

describe('chart spec', () => {
  it('parses every kind', () => {
    for (const kind of CHART_KINDS) {
      expect(chartSpecSchema.safeParse(spec({ kind })).success).toBe(true);
    }
  });

  it('rejects a kind outside the set', () => {
    expect(chartSpecSchema.safeParse(spec({ kind: 'pie' })).success).toBe(false);
    expect(chartSpecSchema.safeParse(spec({ kind: 'scatter' })).success).toBe(false);
  });

  it('requires a null rather than an absent field', () => {
    const { x: _x, ...withoutX } = spec();
    expect(chartSpecSchema.safeParse(withoutX).success).toBe(false);
    expect(chartSpecSchema.safeParse(spec({ x: null, series: null, title: null })).success).toBe(true);
  });

  it('accepts several measures and an empty measure list', () => {
    expect(chartSpecSchema.safeParse(spec({ y: ['users', 'revenue'] })).success).toBe(true);
    expect(chartSpecSchema.safeParse(spec({ kind: 'table', y: [] })).success).toBe(true);
  });

  it('rejects unknown keys', () => {
    const parsed = parseChartSpec(spec({ stacked: true }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('stacked');
  });

  it('does not check that x, y and series name real columns', () => {
    expect(chartSpecSchema.safeParse(spec({ x: 'not_a_column' })).success).toBe(true);
  });
});

const _kindIsNarrow: ChartSpec['kind'] extends 'bar' | 'line' | 'area' | 'table' | 'number' ? true : never =
  true;
void _kindIsNarrow;
