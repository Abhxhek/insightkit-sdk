import { inReadOnlyTransaction } from '../session.js';
import type { ConnectionSource, ReadOptions } from '../types.js';
import { introspectionQueries } from './queries.js';
import type {
  ColumnInfo,
  DatabaseSchema,
  ForeignKey,
  IntrospectOptions,
  TableInfo,
  TableKind,
} from './types.js';

const KINDS: Readonly<Record<string, TableKind>> = {
  r: 'table',
  v: 'view',
  m: 'materialized view',
  p: 'partitioned table',
  f: 'foreign table',
};

type Row = readonly unknown[];

const text = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const maybe = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown): boolean => v === true || v === 't' || v === 'true';

// Length-prefixed so it cannot collide: schema "a b" with table "c" must not key the
// same as schema "a" with table "b c", or one table inherits another's columns.
const key = (...parts: readonly unknown[]): string =>
  parts
    .map((p) => {
      const s = text(p);
      return `${s.length}:${s}`;
    })
    .join('');

const push = <T>(map: Map<string, T[]>, at: string, value: T): void => {
  const bucket = map.get(at);
  if (bucket === undefined) map.set(at, [value]);
  else bucket.push(value);
};

export async function introspectSchema(
  source: ConnectionSource,
  options: IntrospectOptions = {},
  readOptions: ReadOptions = {},
): Promise<DatabaseSchema> {
  const q = introspectionQueries(options);

  return inReadOnlyTransaction(
    source,
    async (ask) => {
      // Sequential on purpose: these share one connection, so issuing them together
      // would rely on the driver queueing them rather than on anything we control.
      const who = await ask(q.whoami);
      const tableRows = await ask(q.tables);
      const columnRows = await ask(q.columns);
      const pkRows = await ask(q.primaryKeys);
      const fkRows = await ask(q.foreignKeys);

      const tablesOver = tableRows.rows.length > q.maxTables;
      const columnsOver = columnRows.rows.length > q.maxColumns;
      const kept = tableRows.rows.slice(0, q.maxTables);
      const known = new Set(kept.map((r: Row) => key(r[0], r[1])));

      const columns = new Map<string, ColumnInfo[]>();
      for (const r of columnRows.rows.slice(0, q.maxColumns) as Row[]) {
        const at = key(r[0], r[1]);
        if (!known.has(at)) continue;
        push(columns, at, {
          name: text(r[2]),
          dataType: text(r[3]),
          typeOid: Number(r[4]),
          nullable: !bool(r[5]),
          comment: maybe(r[6]),
        });
      }

      const primaryKeys = new Map<string, string[]>();
      for (const r of pkRows.rows as Row[]) push(primaryKeys, key(r[0], r[1]), text(r[2]));

      const tables: TableInfo[] = kept.map((r: Row) => {
        const at = key(r[0], r[1]);
        return {
          schema: text(r[0]),
          name: text(r[1]),
          kind: KINDS[text(r[2])] ?? 'table',
          estimatedRows: Number(r[3]) || 0,
          comment: maybe(r[4]),
          columns: columns.get(at) ?? [],
          primaryKey: primaryKeys.get(at) ?? [],
        };
      });

      // One row per key column, so a composite constraint arrives as several rows in
      // ordinal order and is folded back into a single foreign key here.
      const byConstraint = new Map<string, ForeignKey>();
      for (const r of fkRows.rows as Row[]) {
        const at = key(r[0], r[1], r[2]);
        const existing = byConstraint.get(at);
        if (existing === undefined) {
          byConstraint.set(at, {
            name: text(r[0]),
            from: { schema: text(r[1]), table: text(r[2]), columns: [text(r[3])] },
            to: { schema: text(r[4]), table: text(r[5]), columns: [text(r[6])] },
          });
        } else {
          (existing.from.columns as string[]).push(text(r[3]));
          (existing.to.columns as string[]).push(text(r[6]));
        }
      }

      return {
        observedAs: text(who.rows[0]?.[0]),
        tables,
        foreignKeys: [...byConstraint.values()],
        truncated: tablesOver || columnsOver,
      };
    },
    readOptions,
  );
}
