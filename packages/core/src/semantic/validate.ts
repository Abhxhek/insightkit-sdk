import type { DatabaseSchema, TableInfo } from '../introspect/types.js';
import { allowIdentifier, fragmentIssues } from './fragment.js';
import { GLOSSARY_DEFAULTS, phraseKey, surfaceForms } from './glossary.js';
import { renderGlossary } from './render.js';
import type {
  Glossary,
  GlossaryEntry,
  GlossaryProblem,
  GlossaryProblemCode,
  GlossaryRef,
  GlossaryReport,
  GlossaryValidateOptions,
} from './types.js';

const SEVERITY: Readonly<Record<GlossaryProblemCode, 'error' | 'warning'>> = {
  unknown_table: 'error',
  unknown_column: 'error',
  ambiguous_table: 'error',
  sql_without_refs: 'error',
  sql_unsafe: 'error',
  duplicate_term: 'warning',
  unsearchable_term: 'warning',
  empty_entry: 'warning',
  sql_too_long: 'warning',
  sql_unknown_identifier: 'warning',
  globals_exceed_budget: 'warning',
};

const label = (ref: GlossaryRef): string =>
  ref.schema === undefined ? ref.table : `${ref.schema}.${ref.table}`;

const qualified = (table: TableInfo): string => `${table.schema}.${table.name}`;

/**
 * `schema.tables` is what the reader could see, so a ref that misses is either a typo or a
 * name introspection withheld. Problems are returned rather than thrown: a host wants the
 * whole list at startup, not the first one.
 */
export function validateGlossary(
  glossary: Glossary,
  schema: DatabaseSchema,
  options: GlossaryValidateOptions = {},
): GlossaryReport {
  const maxSqlLength = options.maxSqlLength ?? GLOSSARY_DEFAULTS.maxSqlLength;
  const maxTokens = options.maxTokens ?? GLOSSARY_DEFAULTS.maxTokens;
  const problems: GlossaryProblem[] = [];

  const report = (code: GlossaryProblemCode, entry: number, term: string, detail: string): void => {
    problems.push({ code, severity: SEVERITY[code], entry, term, detail });
  };

  for (const [i, entry] of glossary.entries.entries()) {
    checkTerms(entry, i, glossary, report);
    const allowed = checkRefs(entry, i, schema, report);
    checkSql(entry, i, allowed, maxSqlLength, report);
  }

  // Entries with no refs are in every prompt, so they have to fit the budget on their own.
  const globals = renderGlossary(glossary, [], { maxTokens });
  if (globals.omitted > 0) {
    report(
      'globals_exceed_budget',
      -1,
      '',
      `${globals.omitted} entries with no refs do not fit in ${maxTokens} tokens and are dropped from every prompt`,
    );
  }

  return { ok: problems.every((p) => p.severity !== 'error'), problems };
}

type Report = (code: GlossaryProblemCode, entry: number, term: string, detail: string) => void;

function checkTerms(entry: GlossaryEntry, i: number, glossary: Glossary, report: Report): void {
  for (const form of surfaceForms(entry)) {
    const key = phraseKey(form);
    if (key === '') {
      report('unsearchable_term', i, entry.term, `"${form}" has no searchable words and can never match`);
      continue;
    }
    const owner = glossary.byPhrase.get(key);
    if (owner !== undefined && owner !== i) {
      const winner = glossary.entries[owner]?.term ?? '';
      report('duplicate_term', i, entry.term, `"${form}" is already claimed by "${winner}", which wins`);
    }
  }
  if (entry.definition === undefined && entry.sql === undefined && (entry.refs ?? []).length === 0) {
    report('empty_entry', i, entry.term, 'the entry has no definition, no refs and no expression');
  }
}

function checkRefs(
  entry: GlossaryEntry,
  i: number,
  schema: DatabaseSchema,
  report: Report,
): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const ref of entry.refs ?? []) {
    const found = schema.tables.filter(
      (t) => t.name === ref.table && (ref.schema === undefined || t.schema === ref.schema),
    );

    if (found.length === 0) {
      const near = schema.tables.filter((t) => t.name.toLowerCase() === ref.table.toLowerCase());
      const hint = near.length === 0 ? '' : `; did you mean ${near.map(qualified).join(', ')}?`;
      report(
        'unknown_table',
        i,
        entry.term,
        `no table ${label(ref)} is visible to ${schema.observedAs}${hint}`,
      );
      continue;
    }
    if (found.length > 1) {
      report(
        'ambiguous_table',
        i,
        entry.term,
        `${ref.table} is in ${found.map(qualified).join(', ')} — name the schema`,
      );
      continue;
    }

    const table = found[0];
    if (table === undefined) continue;
    allowIdentifier(allowed, table.schema);
    allowIdentifier(allowed, table.name);
    for (const column of ref.columns ?? []) {
      if (table.columns.some((c) => c.name === column)) {
        allowIdentifier(allowed, column);
        continue;
      }
      const near = table.columns.filter((c) => c.name.toLowerCase() === column.toLowerCase());
      const hint = near.length === 0 ? '' : `; did you mean ${near.map((c) => c.name).join(', ')}?`;
      report(
        'unknown_column',
        i,
        entry.term,
        `${qualified(table)} exposes no column ${column} to ${schema.observedAs}${hint}`,
      );
    }
  }
  return allowed;
}

function checkSql(
  entry: GlossaryEntry,
  i: number,
  allowed: ReadonlySet<string>,
  maxSqlLength: number,
  report: Report,
): void {
  if (entry.sql === undefined) return;
  if ((entry.refs ?? []).length === 0) {
    report('sql_without_refs', i, entry.term, 'an expression needs refs, which are what validates it');
    return;
  }
  for (const issue of fragmentIssues(entry.sql, allowed, maxSqlLength)) {
    report(issue.code, i, entry.term, issue.detail);
  }
}
