import { z } from 'zod';
import { type ParseResult, parseWith } from './parse.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * Dates, intervals, bytea and numeric arrive as strings from the reader path, so a Date
 * reaching here is a driver conversion that escaped ADR 0007, not a value to serialise.
 */
export type Cell = JsonValue;

export const cellSchema: z.ZodType<Cell> = jsonValueSchema;

export const parseCell = (value: unknown): ParseResult<Cell> => parseWith(cellSchema, value);
