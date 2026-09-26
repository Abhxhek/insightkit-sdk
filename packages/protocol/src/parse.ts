import type { ZodType } from 'zod';

export interface ParseIssue {
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly issues: readonly ParseIssue[] };

const describe = (issue: ParseIssue): string =>
  issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`;

export const parseWith = <T>(schema: ZodType<T>, value: unknown): ParseResult<T> => {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const issues: ParseIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  const first = issues[0];
  return { ok: false, error: first === undefined ? 'invalid input' : describe(first), issues };
};
