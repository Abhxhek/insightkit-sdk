import type { DatabaseSchema, ForeignKey, TableInfo } from '../introspect/types.js';
import type { RenderOptions } from './render.js';
import { estimateTokens, renderSchema, tableKey } from './render.js';

const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'for',
  'by',
  'with',
  'and',
  'or',
  'to',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  'how',
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'when',
  'where',
  'why',
  'show',
  'me',
  'give',
  'list',
  'get',
  'find',
  'tell',
  'us',
  'i',
  'we',
  'all',
  'any',
  'my',
  'our',
  'their',
  'its',
  'this',
  'that',
  'these',
  'those',
  'per',
  'each',
  'every',
  'over',
  'up',
  'as',
  'it',
  'so',
  'than',
  'then',
]);

const WEIGHT = { name: 10, column: 3, tableComment: 2, columnComment: 1 } as const;

const DEFAULTS = { maxTables: 12, maxTokens: 3000, linkDepth: 1 } as const;

/**
 * Stemming is crude and does not need to be right, only consistent: it is applied to
 * the question and to the schema identically, so "status" reducing to "statu" on both
 * sides still matches. Getting it wrong asymmetrically is the only real failure.
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('sses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function terms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .filter((w) => !STOPWORDS.has(w))
    .map(stem);
}

const at = tableKey;
const endOf = (t: TableInfo): string => at(t.schema, t.name);

function index(table: TableInfo): Map<string, number> {
  const weights = new Map<string, number>();
  const bump = (word: string, weight: number): void => {
    if ((weights.get(word) ?? 0) < weight) weights.set(word, weight);
  };
  for (const w of terms(table.name)) bump(w, WEIGHT.name);
  for (const column of table.columns) {
    for (const w of terms(column.name)) bump(w, WEIGHT.column);
  }
  if (table.comment !== null) for (const w of terms(table.comment)) bump(w, WEIGHT.tableComment);
  for (const column of table.columns) {
    if (column.comment !== null) {
      for (const w of terms(column.comment)) bump(w, WEIGHT.columnComment);
    }
  }
  return weights;
}

export interface RetrieveOptions {
  readonly maxTables?: number;
  readonly maxTokens?: number;
  /** Hops of foreign key to follow out from a matched table. 0 disables it. */
  readonly linkDepth?: number;
  readonly render?: RenderOptions;
}

export interface Selection {
  readonly tables: readonly TableInfo[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly sql: string;
  readonly estimatedTokens: number;
  /** False when nothing in the schema matched, so the selection is a fallback. */
  readonly matched: boolean;
  readonly considered: number;
  readonly omitted: number;
}

export function selectTables(
  schema: DatabaseSchema,
  question: string,
  options: RetrieveOptions = {},
): Selection {
  const maxTables = options.maxTables ?? DEFAULTS.maxTables;
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;
  const linkDepth = options.linkDepth ?? DEFAULTS.linkDepth;
  const asked = [...new Set(terms(question))];

  const degree = new Map<string, number>();
  const neighbours = new Map<string, Set<string>>();
  for (const fk of schema.foreignKeys) {
    const a = at(fk.from.schema, fk.from.table);
    const b = at(fk.to.schema, fk.to.table);
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
    if (a === b) continue;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const set = neighbours.get(x);
      if (set === undefined) neighbours.set(x, new Set([y]));
      else set.add(y);
    }
  }

  const scored = schema.tables.map((table) => {
    const weights = index(table);
    return { table, score: asked.reduce((sum, w) => sum + (weights.get(w) ?? 0), 0) };
  });

  // Ranked by relevance, then by how connected a table is, so that when nothing
  // matches the fallback is the hub tables rather than whatever sorts first.
  const ranked = [...scored].sort(
    (x, y) =>
      y.score - x.score ||
      (degree.get(endOf(y.table)) ?? 0) - (degree.get(endOf(x.table)) ?? 0) ||
      endOf(x.table).localeCompare(endOf(y.table)),
  );

  const matched = ranked.some((r) => r.score > 0);
  const direct = matched ? ranked.filter((r) => r.score > 0).map((r) => r.table) : ranked.map((r) => r.table);

  const order: TableInfo[] = [...direct];
  const byEnd = new Map(schema.tables.map((t) => [endOf(t), t]));
  const queued = new Set(order.map(endOf));
  let frontier = order.slice(0, maxTables).map(endOf);
  for (let hop = 0; hop < linkDepth; hop += 1) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const to of [...(neighbours.get(from) ?? [])].sort()) {
        if (queued.has(to)) continue;
        const table = byEnd.get(to);
        // A join needs both sides described, so a matched table pulls in the tables it
        // points at even when their names say nothing about the question.
        if (table !== undefined) {
          queued.add(to);
          order.push(table);
          next.push(to);
        }
      }
    }
    frontier = next;
  }

  const chosen: TableInfo[] = [];
  let sql = '';
  let omitted = 0;
  for (const table of order) {
    if (chosen.length >= maxTables) {
      omitted += 1;
      continue;
    }
    const candidate = [...chosen, table];
    const rendered = renderSchema(candidate, schema.foreignKeys, options.render);
    if (estimateTokens(rendered) > maxTokens && chosen.length > 0) {
      omitted += 1;
      continue;
    }
    chosen.push(table);
    sql = rendered;
  }

  const present = new Set(chosen.map(endOf));
  return {
    tables: chosen,
    foreignKeys: schema.foreignKeys.filter(
      (fk) => present.has(at(fk.from.schema, fk.from.table)) && present.has(at(fk.to.schema, fk.to.table)),
    ),
    sql,
    estimatedTokens: estimateTokens(sql),
    matched,
    considered: schema.tables.length,
    omitted,
  };
}
