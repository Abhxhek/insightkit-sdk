import type { Cell, ChartKind, ChartSpec, ResultSet } from '@insightkit/protocol';
import { formatNumber, isIsoish, toLabel, toNumber } from './coerce.js';

export const MAX_SERIES = 8;
export const MAX_BAR_CATEGORIES = 30;
export const MAX_TABLE_ROWS = 200;
export const MARKER_LIMIT = 200;

export interface PlotPoint {
  readonly label: string;
  readonly raw: Cell;
  readonly value: number | null;
}

export interface PlotSeries {
  readonly name: string;
  readonly points: readonly PlotPoint[];
}

export interface PlotModel {
  readonly kind: ChartKind;
  readonly title: string | null;
  readonly xLabel: string | null;
  readonly categories: readonly string[];
  readonly series: readonly PlotSeries[];
  readonly notes: readonly string[];
  readonly plottable: number;
  readonly unplottable: number;
}

const cellAt = (row: readonly Cell[], index: number): Cell => {
  if (index < 0) return null;
  const value = row[index];
  return value === undefined ? null : value;
};

const point = (label: string, raw: Cell): PlotPoint => ({ label, raw, value: toNumber(raw) });

const wideSeries = (
  data: ResultSet,
  categories: readonly string[],
  names: readonly string[],
): readonly PlotSeries[] =>
  names.map((name) => {
    const index = data.columns.indexOf(name);
    return {
      name,
      points: data.rows.map((row, i) => point(categories[i] ?? String(i + 1), cellAt(row, index))),
    };
  });

interface Pivot {
  readonly categories: readonly string[];
  readonly series: readonly PlotSeries[];
  readonly duplicates: number;
}

const pivotSeries = (data: ResultSet, xIndex: number, seriesIndex: number, valueIndex: number): Pivot => {
  const categories: string[] = [];
  const names: string[] = [];
  const cells = new Map<string, Cell>();
  let duplicates = 0;
  data.rows.forEach((row, i) => {
    const category = xIndex < 0 ? String(i + 1) : toLabel(cellAt(row, xIndex));
    const name = toLabel(cellAt(row, seriesIndex));
    if (!categories.includes(category)) categories.push(category);
    if (!names.includes(name)) names.push(name);
    const key = `${category}\u0000${name}`;
    if (cells.has(key)) duplicates += 1;
    cells.set(key, cellAt(row, valueIndex));
  });
  const series = names.map((name) => ({
    name,
    points: categories.map((category) => {
      const raw = cells.get(`${category}\u0000${name}`);
      return point(category, raw === undefined ? null : raw);
    }),
  }));
  return { categories, series, duplicates };
};

const reorder = (categories: readonly string[], series: readonly PlotSeries[]): Pivot => {
  const order = categories.map((label, index) => ({ label, index }));
  order.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return {
    categories: order.map((entry) => entry.label),
    series: series.map((one) => ({
      name: one.name,
      points: order.map((entry) => one.points[entry.index] ?? point(entry.label, null)),
    })),
    duplicates: 0,
  };
};

const capCategories = (categories: readonly string[], series: readonly PlotSeries[], cap: number): Pivot => ({
  categories: categories.slice(0, cap),
  series: series.map((one) => ({ name: one.name, points: one.points.slice(0, cap) })),
  duplicates: 0,
});

export const buildPlot = (spec: ChartSpec, data: ResultSet, truncated: boolean): PlotModel => {
  const notes: string[] = [];
  if (truncated) notes.push('The server truncated this result, so rows may be missing.');

  const xIndex = spec.x === null ? -1 : data.columns.indexOf(spec.x);
  const seriesIndex = spec.series === null ? -1 : data.columns.indexOf(spec.series);
  const present = spec.y.filter((name) => data.columns.includes(name));

  let kind: ChartKind = spec.kind;
  let categories: readonly string[] = [];
  let series: readonly PlotSeries[] = [];

  if (kind !== 'table') {
    if (present.length === 0) {
      kind = 'table';
      notes.push(
        'No value column from the chart specification is present in the result, so this is a table.',
      );
    } else if (seriesIndex >= 0 && present.length === 1) {
      const valueName = present[0] ?? '';
      const pivot = pivotSeries(data, xIndex, seriesIndex, data.columns.indexOf(valueName));
      categories = pivot.categories;
      series = pivot.series;
      if (pivot.duplicates > 0) {
        notes.push(
          `${formatNumber(pivot.duplicates)} rows repeated a category and series; the last of each is plotted.`,
        );
      }
    } else {
      categories = data.rows.map((row, i) => (xIndex < 0 ? String(i + 1) : toLabel(cellAt(row, xIndex))));
      series = wideSeries(data, categories, present);
    }
  }

  if (kind !== 'table' && series.length > MAX_SERIES) {
    notes.push(
      `${formatNumber(series.length)} series is more than ${MAX_SERIES} colours can be told apart, so this is a table.`,
    );
    kind = 'table';
    categories = [];
    series = [];
  }

  if ((kind === 'line' || kind === 'area') && categories.length > 1 && categories.every(isIsoish)) {
    const sorted = reorder(categories, series);
    categories = sorted.categories;
    series = sorted.series;
  }

  if (
    (kind === 'bar' || kind === 'line' || kind === 'area') &&
    categories.length === 1 &&
    series.length === 1
  ) {
    kind = 'number';
  }

  if (kind === 'bar' && categories.length > MAX_BAR_CATEGORIES) {
    notes.push(`Showing the first ${MAX_BAR_CATEGORIES} of ${formatNumber(categories.length)} categories.`);
    const capped = capCategories(categories, series, MAX_BAR_CATEGORIES);
    categories = capped.categories;
    series = capped.series;
  }

  let plottable = 0;
  let unplottable = 0;
  for (const one of series) {
    for (const p of one.points) {
      if (p.value === null) unplottable += 1;
      else plottable += 1;
    }
  }
  if (unplottable > 0 && kind !== 'table') {
    notes.push(
      plottable === 0
        ? `None of the ${formatNumber(unplottable)} values could be read as a number, so nothing is plotted. The table below shows them as they arrived.`
        : `${formatNumber(unplottable)} of ${formatNumber(plottable + unplottable)} values could not be read as a number and are left out of the chart, not drawn as zero.`,
    );
  }

  return {
    kind,
    title: spec.title,
    xLabel: spec.x,
    categories,
    series,
    notes,
    plottable,
    unplottable,
  };
};

export const plotValues = (series: readonly PlotSeries[]): readonly number[] => {
  const values: number[] = [];
  for (const one of series) {
    for (const p of one.points) if (p.value !== null) values.push(p.value);
  }
  return values;
};

export interface Segment {
  readonly start: number;
  readonly values: readonly number[];
}

/** A value that will not coerce breaks the line rather than pulling it to zero. */
export const segmentsOf = (points: readonly PlotPoint[]): readonly Segment[] => {
  const segments: Segment[] = [];
  let start = -1;
  let run: number[] = [];
  points.forEach((p, index) => {
    if (p.value === null) {
      if (run.length > 0) segments.push({ start, values: run });
      start = -1;
      run = [];
      return;
    }
    if (start < 0) start = index;
    run.push(p.value);
  });
  if (run.length > 0) segments.push({ start, values: run });
  return segments;
};
