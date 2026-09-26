import { z } from 'zod';
import { cellSchema } from './cell.js';
import { type ParseResult, parseWith } from './parse.js';

export const resultSetSchema = z
  .strictObject({
    columns: z.array(z.string()),
    rows: z.array(z.array(cellSchema)),
  })
  .refine((set) => set.rows.every((row) => row.length === set.columns.length), {
    path: ['rows'],
    message: 'every row must hold exactly one cell per column',
  });

export type ResultSet = z.infer<typeof resultSetSchema>;

export const parseResultSet = (value: unknown): ParseResult<ResultSet> => parseWith(resultSetSchema, value);
