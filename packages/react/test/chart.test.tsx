// @vitest-environment jsdom
import type { ChartKind, ChartSpec, ResultSet } from '@insightkit/protocol';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Chart } from '../src/chart.js';

afterEach(cleanup);

const spec = (kind: ChartKind, over: Partial<ChartSpec> = {}): ChartSpec => ({
  kind,
  x: 'method',
  y: ['users'],
  series: null,
  title: 'Signups by method',
  ...over,
});

const set = (rows: readonly (readonly string[])[]): ResultSet => ({
  columns: ['method', 'users'],
  rows: rows.map((row) => [...row]),
});

const twoRows = set([
  ['google', '1234.5'],
  ['email', '123.45'],
]);

/** The true bar end is the arc's endpoint; the `H` stops 4px short for the rounded data-end. */
const barEnds = (container: HTMLElement): number[] =>
  Array.from(container.querySelectorAll('path.ik-mark')).map((node) => {
    const d = node.getAttribute('d') ?? '';
    const arc = /A4,4 0 0 [01] ([-\d.]+),/.exec(d);
    const flat = /^M([-\d.]+),[-\d.]+H([-\d.]+)/.exec(d);
    if (arc?.[1] !== undefined) return Number(arc[1]);
    return Number(flat?.[2] ?? Number.NaN);
  });

const zeroOf = (container: HTMLElement): number => {
  const d = container.querySelector('path.ik-mark')?.getAttribute('d') ?? '';
  return Number(/^M([-\d.]+),/.exec(d)?.[1] ?? Number.NaN);
};

describe('every chart kind', () => {
  const kinds: readonly ChartKind[] = ['bar', 'line', 'area', 'table', 'number'];

  for (const kind of kinds) {
    it(`renders ${kind} with rows`, () => {
      const { container } = render(<Chart spec={spec(kind)} data={twoRows} />);
      expect(container.querySelector('.ik-root')).not.toBeNull();
    });

    it(`renders ${kind} with zero rows without throwing`, () => {
      const { container } = render(<Chart spec={spec(kind)} data={set([])} />);
      expect(container.textContent ?? '').toContain('No rows');
    });

    it(`renders ${kind} with an all-null column`, () => {
      const { container } = render(
        <Chart
          spec={spec(kind)}
          data={{
            columns: ['method', 'users'],
            rows: [
              ['a', null],
              ['b', null],
            ],
          }}
        />,
      );
      expect(container.querySelectorAll('path.ik-mark, circle.ik-mark')).toHaveLength(0);
      if (kind !== 'table') expect(container.textContent ?? '').toContain('read as a number');
      expect(within(container).getAllByRole('columnheader')).toHaveLength(2);
    });
  }
});

describe('string-encoded numbers', () => {
  it('plots "1234.5" as a number, ten times the bar for "123.45"', () => {
    const { container } = render(<Chart spec={spec('bar')} data={twoRows} />);
    const ends = barEnds(container);
    const zero = zeroOf(container);
    expect(ends).toHaveLength(2);
    const big = (ends[0] ?? 0) - zero;
    const small = (ends[1] ?? 0) - zero;
    expect(big).toBeGreaterThan(0);
    expect(small).toBeGreaterThan(0);
    expect(big / small).toBeCloseTo(10, 1);
  });

  it('leaves a value it cannot read out of the chart instead of drawing it at zero', () => {
    const { container } = render(
      <Chart
        spec={spec('bar')}
        data={set([
          ['google', '1234.5'],
          ['email', 'n/a'],
        ])}
      />,
    );
    const ends = barEnds(container);
    expect(ends).toHaveLength(1);
    expect((ends[0] ?? 0) - zeroOf(container)).toBeGreaterThan(100);
    expect(container.textContent ?? '').toContain('not drawn as zero');
  });

  it('treats a NaN string as a gap, since NaN has no position on a number line', () => {
    const { container } = render(
      <Chart
        spec={spec('line', { x: 'day' })}
        data={{
          columns: ['day', 'users'],
          rows: [
            ['2026-09-01', '1'],
            ['2026-09-02', 'NaN'],
            ['2026-09-03', '3'],
          ],
        }}
      />,
    );
    expect(container.querySelectorAll('polyline.ik-line')).toHaveLength(2);
    expect(container.textContent ?? '').toContain('could not be read');
  });
});

describe('untrusted text', () => {
  const nasty: ResultSet = {
    columns: ['<img src=x onerror="alert(1)">'],
    rows: [['<script>alert(1)</script>'], ["'; DROP TABLE users; --"]],
  };

  it('renders a customer column name and cell value as text, never as markup', () => {
    const { container } = render(
      <Chart spec={{ kind: 'table', x: null, y: [], series: null, title: '<b>Signups</b>' }} data={nasty} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy();
    expect(screen.getByText('<b>Signups</b>')).toBeTruthy();
  });

  it('keeps markup out of a bar chart axis label too', () => {
    const { container } = render(
      <Chart
        spec={spec('bar')}
        data={set([
          ['<script>x</script>', '1'],
          ['ok', '2'],
        ])}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
  });
});

describe('accessibility and fallbacks', () => {
  it('names the chart for assistive technology', () => {
    render(<Chart spec={spec('bar')} data={twoRows} />);
    expect(screen.getByRole('img', { name: /Bar chart: Signups by method/ })).toBeTruthy();
  });

  it('keeps a table behind every visual so no value is reachable only by hovering', () => {
    const { container } = render(<Chart spec={spec('line', { x: 'day' })} data={twoRows} />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(within(details as HTMLElement).getAllByRole('columnheader')).toHaveLength(2);
  });

  it('shows a legend only once there are two series to tell apart', () => {
    const one = render(<Chart spec={spec('bar')} data={twoRows} />);
    expect(one.container.querySelector('.ik-legend')).toBeNull();
    cleanup();
    const two = render(
      <Chart
        spec={{ kind: 'bar', x: 'method', y: ['users', 'sessions'], series: null, title: null }}
        data={{
          columns: ['method', 'users', 'sessions'],
          rows: [
            ['google', '1', '2'],
            ['email', '3', '4'],
          ],
        }}
      />,
    );
    expect(two.container.querySelectorAll('.ik-legend li')).toHaveLength(2);
  });

  it('carries its own theme tokens and honours an explicit dark stamp', () => {
    const { container } = render(<Chart spec={spec('bar')} data={twoRows} theme="dark" />);
    expect(container.querySelector('.ik-root')?.getAttribute('data-ik-theme')).toBe('dark');
    expect(container.querySelector('style')?.textContent ?? '').toContain('prefers-color-scheme:dark');
  });
});

describe('degenerate shapes', () => {
  it('turns a single row into a stat tile rather than a one-bar bar chart', () => {
    const { container } = render(<Chart spec={spec('bar')} data={set([['google', '12']])} />);
    expect(container.querySelector('.ik-hero')?.textContent).toBe('12');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows the exact text when a stat tile value will not survive a double', () => {
    const { container } = render(
      <Chart spec={spec('number')} data={set([['google', '12345678901234567890.12']])} />,
    );
    expect(container.querySelector('.ik-hero')?.textContent).toBe('12345678901234567890.12');
  });

  it('caps a very large result and says how much it is showing', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => [`c${i}`, String(i)]);
    const { container } = render(<Chart spec={spec('bar')} data={set(rows)} />);
    expect(container.querySelectorAll('path.ik-mark').length).toBe(30);
    expect(container.textContent ?? '').toContain('first 30 of 10,000 categories');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(200);
  });

  it('says when the server truncated the result', () => {
    const { container } = render(<Chart spec={spec('bar')} data={twoRows} truncated />);
    expect(container.textContent ?? '').toContain('truncated');
  });
});
