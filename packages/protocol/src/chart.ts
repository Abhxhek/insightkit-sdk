import { z } from 'zod';
import { type ParseResult, parseWith } from './parse.js';

export const CHART_KINDS = ['bar', 'line', 'area', 'table', 'number'] as const;

export const chartKindSchema = z.enum(CHART_KINDS);

export type ChartKind = z.infer<typeof chartKindSchema>;

export const chartSpecSchema = z.strictObject({
  kind: chartKindSchema,
  x: z.string().nullable(),
  y: z.array(z.string()),
  series: z.string().nullable(),
  title: z.string().nullable(),
});

export type ChartSpec = z.infer<typeof chartSpecSchema>;

export const parseChartSpec = (value: unknown): ParseResult<ChartSpec> => parseWith(chartSpecSchema, value);
