import { describe, expect, it } from 'vitest';
import { formatValue, isIsoish, toLabel, toNumber } from '../src/coerce.js';
import { linearScale } from '../src/scale.js';
import { buildPlot, segmentsOf } from '../src/series.js';

describe('toNumber', () => {
  it('reads the strings ADR 0007 puts on the wire as numbers', () => {
    expect(toNumber('1234.5')).toBe(1234.5);
    expect(toNumber('-0.25')).toBe(-0.25);
    expect(toNumber('9007199254740993')).toBe(9007199254740992);
    expect(toNumber('1e3')).toBe(1000);
    expect(toNumber('  42  ')).toBe(42);
    expect(toNumber(7)).toBe(7);
  });

  it('never turns a value it cannot read into zero', () => {
    for (const value of [
      'n/a',
      '',
      '   ',
      'NaN',
      'Infinity',
      '-Infinity',
      '1,234',
      '0x10',
      '12 rows',
      null,
    ]) {
      expect(toNumber(value)).toBeNull();
    }
    expect(toNumber(true)).toBeNull();
    expect(toNumber({ a: 1 })).toBeNull();
    expect(toNumber([1, 2])).toBeNull();
  });

  it('keeps precision the double would lose by showing the text Postgres sent', () => {
    expect(formatValue('12345678901234567890.12')).toBe('12345678901234567890.12');
    expect(formatValue('1.50')).toBe('1.50');
  });
});

describe('toLabel', () => {
  it('describes every cell shape without throwing', () => {
    expect(toLabel(null)).toBe('—');
    expect(toLabel('google')).toBe('google');
    expect(toLabel(3)).toBe('3');
    expect(toLabel(false)).toBe('false');
    expect(toLabel({ a: 1 })).toBe('{"a":1}');
  });
});

describe('isIsoish', () => {
  it('accepts zoneless and Z-suffixed ISO text, which sorts chronologically', () => {
    expect(isIsoish('2026-09-05')).toBe(true);
    expect(isIsoish('2026-09-05T13:45:00Z')).toBe(true);
    expect(isIsoish('2026-09-05 13:45')).toBe(true);
  });

  it('rejects an offset, where lexical order stops being chronological', () => {
    expect(isIsoish('2026-09-05T13:45:00+05:30')).toBe(false);
    expect(isIsoish('05/09/2026')).toBe(false);
  });
});

describe('linearScale', () => {
  it('anchors at zero when asked and produces round ticks', () => {
    const scale = linearScale([3, 47], { includeZero: true });
    expect(scale.min).toBe(0);
    expect(scale.max).toBeGreaterThanOrEqual(47);
    expect(scale.ticks[0]).toBe(0);
  });

  it('survives an all-equal column and an empty column', () => {
    expect(linearScale([5, 5], { includeZero: false }).min).toBeLessThan(5);
    expect(linearScale([], { includeZero: false })).toEqual({ min: 0, max: 1, ticks: [0, 1] });
  });
});

describe('segmentsOf', () => {
  it('breaks the line at a value that will not coerce instead of bridging it', () => {
    const model = buildPlot(
      { kind: 'line', x: 'day', y: ['n'], series: null, title: null },
      {
        columns: ['day', 'n'],
        rows: [
          ['2026-09-01', '1'],
          ['2026-09-02', 'n/a'],
          ['2026-09-03', '3'],
        ],
      },
      false,
    );
    const first = model.series[0];
    expect(first).toBeDefined();
    expect(segmentsOf(first?.points ?? [])).toEqual([
      { start: 0, values: [1] },
      { start: 2, values: [3] },
    ]);
  });
});

describe('buildPlot', () => {
  it('sorts an ISO date axis but leaves a bar ranking alone', () => {
    const rows = [
      ['2026-09-03', '3'],
      ['2026-09-01', '1'],
    ];
    const spec = { x: 'day', y: ['n'], series: null, title: null };
    const line = buildPlot({ ...spec, kind: 'line' }, { columns: ['day', 'n'], rows }, false);
    expect(line.categories).toEqual(['2026-09-01', '2026-09-03']);
    const bar = buildPlot({ ...spec, kind: 'bar' }, { columns: ['day', 'n'], rows }, false);
    expect(bar.categories).toEqual(['2026-09-03', '2026-09-01']);
  });

  it('pivots a long result into one series per distinct series value', () => {
    const model = buildPlot(
      { kind: 'line', x: 'day', y: ['n'], series: 'method', title: null },
      {
        columns: ['day', 'method', 'n'],
        rows: [
          ['2026-09-01', 'google', '1'],
          ['2026-09-01', 'email', '2'],
          ['2026-09-02', 'google', '3'],
        ],
      },
      false,
    );
    expect(model.series.map((one) => one.name)).toEqual(['google', 'email']);
    expect(model.series[1]?.points[1]?.value).toBeNull();
  });

  it('falls back to a table past eight series rather than inventing a ninth colour', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ['a', `s${i}`, '1']);
    const model = buildPlot(
      { kind: 'bar', x: 'x', y: ['n'], series: 's', title: null },
      { columns: ['x', 's', 'n'], rows },
      false,
    );
    expect(model.kind).toBe('table');
    expect(model.notes.join(' ')).toContain('table');
  });

  it('counts what it could not plot and says so', () => {
    const model = buildPlot(
      { kind: 'bar', x: 'x', y: ['n'], series: null, title: null },
      {
        columns: ['x', 'n'],
        rows: [
          ['a', '1234.5'],
          ['b', 'n/a'],
        ],
      },
      false,
    );
    expect(model.plottable).toBe(1);
    expect(model.unplottable).toBe(1);
    expect(model.notes.join(' ')).toContain('not drawn as zero');
  });

  it('turns a single row into a stat tile rather than a one-bar bar chart', () => {
    const model = buildPlot(
      { kind: 'bar', x: 'x', y: ['n'], series: null, title: null },
      { columns: ['x', 'n'], rows: [['a', '9']] },
      false,
    );
    expect(model.kind).toBe('number');
  });
});
