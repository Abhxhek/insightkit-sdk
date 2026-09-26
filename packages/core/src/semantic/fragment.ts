import type { FragmentIssue } from './types.js';

/**
 * A fragment is prompt text, never SQL we run: the model reads it, writes its own query, and
 * the guard validates that. What it can still do is name a column introspection withheld, so
 * everything it mentions has to be something the entry declared and validation has checked.
 */
const UNSAFE: readonly (readonly [RegExp, string])[] = [
  [/\0/, 'a NUL byte'],
  [/;/, 'a statement separator'],
  [/--/, 'a line comment'],
  [/\/\*|\*\//, 'a block comment'],
];

const KEYWORDS: ReadonlySet<string> = new Set([
  'all',
  'and',
  'any',
  'as',
  'asc',
  'at',
  'between',
  'bigint',
  'bool',
  'boolean',
  'by',
  'case',
  'cast',
  'char',
  'character',
  'collate',
  'current',
  'date',
  'day',
  'decimal',
  'desc',
  'distinct',
  'double',
  'dow',
  'doy',
  'else',
  'end',
  'epoch',
  'escape',
  'exists',
  'false',
  'filter',
  'first',
  'float',
  'following',
  'for',
  'from',
  'group',
  'hour',
  'ilike',
  'in',
  'int',
  'integer',
  'interval',
  'is',
  'isnull',
  'json',
  'jsonb',
  'last',
  'like',
  'local',
  'minute',
  'month',
  'no',
  'not',
  'notnull',
  'null',
  'nulls',
  'numeric',
  'on',
  'or',
  'order',
  'over',
  'partition',
  'preceding',
  'precision',
  'quarter',
  'range',
  'real',
  'row',
  'rows',
  'second',
  'similar',
  'smallint',
  'some',
  'symmetric',
  'text',
  'then',
  'time',
  'timestamp',
  'timestamptz',
  'timetz',
  'timezone',
  'true',
  'unbounded',
  'unknown',
  'using',
  'uuid',
  'varchar',
  'week',
  'when',
  'where',
  'within',
  'year',
  'zone',
]);

const LITERAL = /'(?:[^']|'')*'/g;
const QUOTED = /"(?:[^"]|"")*"/g;

export const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Both spellings, so a bare word is judged folded and a quoted identifier exactly. */
export const allowIdentifier = (allowed: Set<string>, name: string): void => {
  allowed.add(name);
  allowed.add(name.toLowerCase());
};

function unknownIdentifiers(sql: string, allowed: ReadonlySet<string>): string[] {
  const quoted: string[] = [];
  const bare = sql.replace(LITERAL, "''").replace(QUOTED, (found) => {
    quoted.push(found.slice(1, -1).replace(/""/g, '"'));
    return ' ';
  });

  const unknown = new Set<string>();
  for (const name of quoted) if (!allowed.has(name)) unknown.add(name);

  const word = /[A-Za-z_][A-Za-z0-9_]*/g;
  let found = word.exec(bare);
  while (found !== null) {
    const name = found[0];
    const rest = bare.slice(found.index + name.length).trimStart();
    const lower = name.toLowerCase();
    // A name followed by an open paren is a function, which the guard's allowlist judges.
    if (!rest.startsWith('(') && !KEYWORDS.has(lower) && !allowed.has(lower)) unknown.add(name);
    found = word.exec(bare);
  }
  return [...unknown];
}

/**
 * Empty means the fragment is safe to put in a prompt. Both validation and rendering call
 * this, so what a host is warned about at startup is exactly what rendering leaves out.
 */
export function fragmentIssues(
  sql: string,
  allowed: ReadonlySet<string>,
  maxLength: number,
): readonly FragmentIssue[] {
  const issues: FragmentIssue[] = [];
  for (const [pattern, what] of UNSAFE) {
    if (pattern.test(sql)) issues.push({ code: 'sql_unsafe', detail: `the expression contains ${what}` });
  }

  const text = collapse(sql);
  if (text.length > maxLength) {
    issues.push({
      code: 'sql_too_long',
      detail: `the expression is ${text.length} characters, over the ${maxLength} allowed`,
    });
  }
  for (const name of unknownIdentifiers(text, allowed)) {
    issues.push({
      code: 'sql_unknown_identifier',
      detail: `"${name}" is not a table or column the entry declares`,
    });
  }
  return issues;
}
