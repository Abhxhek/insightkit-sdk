import { assertIdent, quoteLiteral } from '../sql.js';
import type { IntrospectOptions } from './types.js';

export const DEFAULT_MAX_TABLES = 200;
export const DEFAULT_MAX_COLUMNS = 5000;

const RELKINDS = "('r','v','m','p','f')";

const count = (name: string, value: number, max: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer between 1 and ${max}, got ${value}`);
  }
  return value;
};

/**
 * The set of tables described has to equal the set the querying role can actually
 * read. Introspecting as an admin would advertise tables the reader cannot select
 * from, which produces failing SQL at best and, for a schema a customer deliberately
 * kept out of reach, discloses that it exists at all.
 */
function visibility(asRole: string | undefined) {
  const who = asRole === undefined ? '' : `${quoteLiteral(assertIdent(asRole, 'asRole'), 'asRole')}, `;
  return {
    schema: (oid: string) => `pg_catalog.has_schema_privilege(${who}${oid}, 'USAGE')`,
    table: (oid: string) => `pg_catalog.has_table_privilege(${who}${oid}, 'SELECT')`,
    column: (oid: string, attnum: string) =>
      `pg_catalog.has_column_privilege(${who}${oid}, ${attnum}, 'SELECT')`,
  };
}

function schemaFilter(alias: string, options: IntrospectOptions): string {
  const clauses = [`${alias}.nspname NOT LIKE 'pg\\_%'`, `${alias}.nspname <> 'information_schema'`];
  if (options.schemas !== undefined) {
    if (options.schemas.length === 0) throw new RangeError('schemas must name at least one schema');
    const list = options.schemas.map((s) => quoteLiteral(s, 'schema')).join(', ');
    clauses.push(`${alias}.nspname IN (${list})`);
  }
  for (const s of options.excludeSchemas ?? []) {
    clauses.push(`${alias}.nspname <> ${quoteLiteral(s, 'excluded schema')}`);
  }
  return clauses.join('\n  AND ');
}

export interface IntrospectionQueries {
  readonly whoami: string;
  readonly tables: string;
  readonly columns: string;
  readonly primaryKeys: string;
  readonly foreignKeys: string;
  readonly maxTables: number;
  readonly maxColumns: number;
}

export function introspectionQueries(options: IntrospectOptions = {}): IntrospectionQueries {
  const maxTables = count('maxTables', options.maxTables ?? DEFAULT_MAX_TABLES, 10_000);
  const maxColumns = count('maxColumns', options.maxColumns ?? DEFAULT_MAX_COLUMNS, 200_000);
  const can = visibility(options.asRole);

  const tableScope = (alias: string, nsAlias: string) => `
  ${alias}.relkind IN ${RELKINDS}
  AND ${schemaFilter(nsAlias, options)}
  AND ${can.schema(`${nsAlias}.oid`)}
  AND ${can.table(`${alias}.oid`)}`;

  return {
    maxTables,
    maxColumns,

    whoami:
      options.asRole === undefined
        ? 'SELECT pg_catalog.current_user()::text'
        : `SELECT ${quoteLiteral(assertIdent(options.asRole, 'asRole'), 'asRole')}::text`,

    // reltuples is -1 on a relation that has never been analysed, and an estimate
    // everywhere else. It is only ever used to rank candidates, never to answer.
    tables: `SELECT n.nspname::text,
       c.relname::text,
       c.relkind::text,
       GREATEST(c.reltuples, 0)::bigint::text,
       pg_catalog.obj_description(c.oid, 'pg_class')::text
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE${tableScope('c', 'n')}
ORDER BY n.nspname, c.relname
LIMIT ${maxTables + 1}`,

    columns: `SELECT n.nspname::text,
       c.relname::text,
       a.attname::text,
       pg_catalog.format_type(a.atttypid, a.atttypmod)::text,
       a.atttypid::int,
       a.attnotnull,
       pg_catalog.col_description(c.oid, a.attnum)::text
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE a.attnum > 0
  AND NOT a.attisdropped
  AND${tableScope('c', 'n')}
  AND ${can.column('c.oid', 'a.attnum')}
ORDER BY n.nspname, c.relname, a.attnum
LIMIT ${maxColumns + 1}`,

    // conkey is a real int2[], unlike pg_index.indkey which is an int2vector, so
    // unnest WITH ORDINALITY gives the key columns in their defined order.
    primaryKeys: `SELECT n.nspname::text,
       c.relname::text,
       a.attname::text
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
WHERE con.contype = 'p'
  AND${tableScope('c', 'n')}
  AND ${can.column('c.oid', 'a.attnum')}
ORDER BY n.nspname, c.relname, k.ord`,

    // Both ends are filtered, so a constraint pointing at a table the role cannot
    // read is omitted rather than disclosing that the table exists.
    foreignKeys: `SELECT con.conname::text,
       n.nspname::text,
       c.relname::text,
       a.attname::text,
       fn.nspname::text,
       fc.relname::text,
       fa.attname::text
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord)
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
JOIN pg_catalog.pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = k.fattnum
WHERE con.contype = 'f'
  AND${tableScope('c', 'n')}
  AND${tableScope('fc', 'fn')}
ORDER BY n.nspname, c.relname, con.conname, k.ord`,
  };
}
