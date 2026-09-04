import type { DatabaseSchema, ForeignKey, TableInfo } from '../introspect/types.js';

const PLAIN = /^[a-z_][a-z0-9_]*$/;

const ident = (name: string): string => (PLAIN.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

const qualified = (schema: string, name: string): string => `${ident(schema)}.${ident(name)}`;

/** Length-prefixed so schema "a" table "bc" cannot key the same as schema "ab" table "c". */
export const tableKey = (schema: string, name: string): string =>
  `${schema.length}:${schema}${name.length}:${name}`;

const KEYWORD: Readonly<Record<string, string>> = {
  table: 'TABLE',
  view: 'VIEW',
  'materialized view': 'MATERIALIZED VIEW',
  'partitioned table': 'TABLE',
  'foreign table': 'FOREIGN TABLE',
};

export interface RenderOptions {
  readonly includeComments?: boolean;
  readonly includeRowCounts?: boolean;
}

const comment = (text: string): string => text.replace(/\s+/g, ' ').trim();

function renderTable(table: TableInfo, outbound: readonly ForeignKey[], options: RenderOptions): string {
  const lines: string[] = [];
  const withComments = options.includeComments !== false;

  if (withComments && table.comment !== null) lines.push(`-- ${comment(table.comment)}`);
  if (options.includeRowCounts !== false) {
    lines.push(`-- approximately ${table.estimatedRows.toLocaleString('en-US')} rows`);
  }
  lines.push(`CREATE ${KEYWORD[table.kind] ?? 'TABLE'} ${qualified(table.schema, table.name)} (`);

  // The separator sits between a definition and its trailing comment, so the two are
  // kept apart and joined once the last entry is known. Emitting the comma eagerly and
  // pulling it back off would mean a pattern searching comment text we do not control.
  const body: { code: string; note: string }[] = table.columns.map((c) => ({
    code: `${ident(c.name)} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}`,
    note: withComments && c.comment !== null ? ` -- ${comment(c.comment)}` : '',
  }));

  if (table.primaryKey.length > 0) {
    body.push({ code: `PRIMARY KEY (${table.primaryKey.map(ident).join(', ')})`, note: '' });
  }
  for (const fk of outbound) {
    body.push({
      code:
        `FOREIGN KEY (${fk.from.columns.map(ident).join(', ')}) REFERENCES ` +
        `${qualified(fk.to.schema, fk.to.table)} (${fk.to.columns.map(ident).join(', ')})`,
      note: '',
    });
  }

  const last = body.length - 1;
  lines.push(...body.map((e, i) => `  ${e.code}${i === last ? '' : ','}${e.note}`), ');');
  return lines.join('\n');
}

/**
 * Postgres DDL rather than a bespoke format: a model has seen far more CREATE TABLE
 * than anything we could invent, and the output doubles as something a human can read
 * when a plan comes back wrong.
 */
export function renderSchema(
  tables: readonly TableInfo[],
  foreignKeys: readonly ForeignKey[],
  options: RenderOptions = {},
): string {
  const present = new Set(tables.map((t) => tableKey(t.schema, t.name)));
  return tables
    .map((t) =>
      renderTable(
        t,
        // A reference to a table that was not selected would invite a join against
        // something the prompt never describes.
        foreignKeys.filter(
          (fk) =>
            fk.from.schema === t.schema &&
            fk.from.table === t.name &&
            present.has(tableKey(fk.to.schema, fk.to.table)),
        ),
        options,
      ),
    )
    .join('\n\n');
}

/** Rough, and deliberately so: used only to keep a prompt inside a budget. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const renderDatabase = (schema: DatabaseSchema, options: RenderOptions = {}): string =>
  renderSchema(schema.tables, schema.foreignKeys, options);
