import type { TableInfo } from '../introspect/types.js';
import { estimateTokens } from '../plan/render.js';
import { allowIdentifier, collapse, fragmentIssues } from './fragment.js';
import { GLOSSARY_DEFAULTS } from './glossary.js';
import type { Glossary, GlossaryEntry, GlossaryRenderOptions, GlossarySection } from './types.js';

const HEADER = 'Business terms for this database. Use these definitions rather than reading a name:';

const sentence = (text: string): string => {
  const one = collapse(text);
  return /[.!?]$/.test(one) ? one : `${one}.`;
};

interface Located {
  readonly names: readonly string[];
  readonly allowed: ReadonlySet<string>;
  /** Every ref resolved and every column it declared was found on a selected table. */
  readonly complete: boolean;
  readonly relevant: boolean;
}

/**
 * Only names taken off a selected table are ever emitted, so an entry pointing at a column
 * introspection withheld cannot put that column into a prompt even unvalidated.
 */
function locate(entry: GlossaryEntry, tables: readonly TableInfo[]): Located {
  const refs = entry.refs ?? [];
  const names = new Set<string>();
  const allowed = new Set<string>();
  let complete = refs.length > 0;
  let resolved = false;

  for (const ref of refs) {
    const found = tables.filter(
      (t) => t.name === ref.table && (ref.schema === undefined || t.schema === ref.schema),
    );
    if (found.length === 0) {
      complete = false;
      continue;
    }
    resolved = true;
    const wanted = ref.columns ?? [];
    for (const table of found) {
      allowIdentifier(allowed, table.schema);
      allowIdentifier(allowed, table.name);
      const present = wanted.filter((c) => table.columns.some((col) => col.name === c));
      for (const column of present) {
        allowIdentifier(allowed, column);
        names.add(`${table.schema}.${table.name}.${column}`);
      }
      if (wanted.length === 0) names.add(`${table.schema}.${table.name}`);
      if (present.length !== wanted.length) complete = false;
    }
  }

  return { names: [...names], allowed, complete, relevant: refs.length === 0 || resolved };
}

function renderEntry(entry: GlossaryEntry, located: Located, options: GlossaryRenderOptions): string | null {
  const synonyms = (entry.synonyms ?? []).map(collapse).filter((s) => s !== '');
  const head =
    synonyms.length === 0
      ? `- ${collapse(entry.term)}`
      : `- ${collapse(entry.term)} (also: ${synonyms.join(', ')})`;

  const body: string[] = [];
  if (entry.definition !== undefined && collapse(entry.definition) !== '') {
    body.push(sentence(entry.definition));
  }
  if (located.names.length > 0) body.push(`Uses ${located.names.join(', ')}.`);

  if (entry.sql !== undefined && options.includeSql !== false && located.complete) {
    const maxSqlLength = options.maxSqlLength ?? GLOSSARY_DEFAULTS.maxSqlLength;
    if (fragmentIssues(entry.sql, located.allowed, maxSqlLength).length === 0) {
      body.push(`SQL: ${collapse(entry.sql)}`);
    }
  }

  return body.length === 0 ? null : `${head}: ${body.join(' ')}`;
}

/**
 * The whole glossary in every prompt is a token bill on every question and dilutes whatever
 * was relevant, so an entry is rendered only when it concerns a table retrieval actually chose.
 * An entry with no refs is a convention rather than a mapping, and is always rendered.
 */
export function renderGlossary(
  glossary: Glossary,
  tables: readonly TableInfo[],
  options: GlossaryRenderOptions = {},
): GlossarySection {
  const maxTokens = options.maxTokens ?? GLOSSARY_DEFAULTS.maxTokens;
  const maxEntries = options.maxEntries ?? GLOSSARY_DEFAULTS.maxEntries;

  const candidates: { term: string; line: string }[] = [];
  for (const entry of glossary.entries) {
    const located = locate(entry, tables);
    if (!located.relevant) continue;
    const line = renderEntry(entry, located, options);
    if (line !== null) candidates.push({ term: entry.term, line });
  }

  const lines: string[] = [];
  const included: string[] = [];
  let text = '';
  let omitted = 0;
  for (const candidate of candidates) {
    const next = [HEADER, ...lines, candidate.line].join('\n');
    if (lines.length >= maxEntries || estimateTokens(next) > maxTokens) {
      omitted += 1;
      continue;
    }
    lines.push(candidate.line);
    included.push(candidate.term);
    text = next;
  }

  return { text, included, omitted, estimatedTokens: estimateTokens(text) };
}
