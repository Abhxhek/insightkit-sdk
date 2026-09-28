import { createHash } from 'node:crypto';
import type { ForeignKey, TableInfo } from '../introspect/types.js';
import type { Glossary } from '../semantic/types.js';
import type { CacheKey, CacheKeyInput } from './types.js';

export const CACHE_KEY_VERSION = 1;
export const DEFAULT_PLANNER_VERSION = 'v1';

const TEXT = new TextEncoder();

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

// Length prefixes, so ('ab','c') and ('a','bc') cannot hash alike.
const part = (label: string, value: string): string => `${label}:${TEXT.encode(value).length}:${value};`;

// Each element is prefixed too. Joining on a separator inside one part is not enough:
// ['a\0b'] and ['a','b'] produce the same bytes, and the outer length cannot tell them
// apart. Reachable through glossary synonyms, which are arbitrary host-authored strings.
const list = (label: string, values: readonly string[]): string =>
  part(label, values.map((v) => part('i', v)).join(''));

/**
 * Case is preserved. Lowercasing would lift the hit rate, but `US` and `us` are not
 * always the same word, and a miss costs a model call while a wrong hit costs the answer.
 */
export function normalizeQuestion(question: string): string {
  return question.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

const columnPart = (table: TableInfo): string =>
  table.columns
    .map((c) => part('col', `${c.name}|${c.dataType}|${c.nullable ? 'null' : 'notnull'}|${c.comment ?? ''}`))
    .join('');

const tablePart = (table: TableInfo): string =>
  part('tbl', `${table.schema}.${table.name}`) +
  part('kind', table.kind) +
  part('tcomment', table.comment ?? '') +
  list('pk', table.primaryKey) +
  columnPart(table);

const fkShape = (fk: ForeignKey): string =>
  `${fk.from.schema}.${fk.from.table}(${fk.from.columns.join(',')})->${fk.to.schema}.${fk.to.table}(${fk.to.columns.join(',')})`;

/**
 * Row estimates are left out on purpose: they move on every autovacuum without changing
 * which SQL is correct, and hashing the rendered DDL would therefore expire the whole
 * cache on a background job. Type OIDs are left out for the same reason across a restore.
 * Constraint names are left out; only the shape of a foreign key reaches the prompt.
 */
export function schemaDigest(tables: readonly TableInfo[], foreignKeys: readonly ForeignKey[] = []): string {
  const ordered = [...tables].sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
  const links = [...foreignKeys].map(fkShape).sort();
  return sha256(ordered.map(tablePart).join('') + list('fk', links));
}

/**
 * The whole glossary, not just the entries that matched. An added entry changes what a
 * later question would match, so hashing only the matches would leave the old plan
 * looking current after exactly the edit that was meant to correct it.
 */
export function glossaryDigest(glossary: Glossary | null | undefined): string {
  if (glossary === null || glossary === undefined) return sha256(part('glossary', ''));
  const entries = glossary.entries.map((e) =>
    [
      part('term', e.term),
      list('syn', e.synonyms ?? []),
      part('def', e.definition ?? ''),
      part('sql', e.sql ?? ''),
      list(
        'refs',
        (e.refs ?? []).map((r) => `${r.schema ?? ''}.${r.table}(${(r.columns ?? []).join(',')})`),
      ),
    ].join(''),
  );
  return sha256(entries.join(''));
}

export function cacheKey(input: CacheKeyInput): CacheKey {
  const question = normalizeQuestion(input.question);
  if (question.length === 0) throw new RangeError('cache key needs a question');

  const schema = schemaDigest(input.tables, input.foreignKeys ?? []);
  const glossary = glossaryDigest(input.glossary);
  const plannerVersion = input.plannerVersion ?? DEFAULT_PLANNER_VERSION;

  const key = sha256(
    part('v', String(CACHE_KEY_VERSION)) +
      part('q', question) +
      part('schema', schema) +
      part('glossary', glossary) +
      part('planner', plannerVersion) +
      part('maxRows', input.maxRows === null || input.maxRows === undefined ? '' : String(input.maxRows)) +
      part('guidance', input.guidance ?? ''),
  );

  return { key, question, schemaDigest: schema, glossaryDigest: glossary, plannerVersion };
}

export const contentHash = sha256;
