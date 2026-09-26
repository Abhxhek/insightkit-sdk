import { parseArgs } from 'node:util';
import { UsageError } from './errors.js';

export interface FlagSpec {
  readonly type: 'string' | 'boolean';
  readonly multiple?: boolean;
  readonly short?: string;
}

export type FlagSpecs = Readonly<Record<string, FlagSpec>>;
export type Flags = Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;

const USAGE_CODES: ReadonlySet<string> = new Set([
  'ERR_PARSE_ARGS_UNKNOWN_OPTION',
  'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
  'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
]);

export function parseFlags(argv: readonly string[], specs: FlagSpecs): Flags {
  try {
    return parseArgs({
      args: [...argv],
      options: { ...specs },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && USAGE_CODES.has(code)) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

export function takeString(flags: Flags, name: string, fallback: string): string {
  const value = flags[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new UsageError(`--${name} takes a single value`);
  return value;
}

export function takeFlag(flags: Flags, name: string): boolean {
  return flags[name] === true;
}

export function takeList(flags: Flags, name: string): readonly string[] {
  const value = flags[name];
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.filter((item): item is string => typeof item === 'string');
}

export function takeNumber(flags: Flags, name: string, fallback: number, min: number, max: number): number {
  const value = flags[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new UsageError(`--${name} takes a single value`);
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(
      `--${name} must be a whole number between ${min} and ${max}, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}
