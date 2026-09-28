import type { Guard, Policy } from '@insightkit/sql-guard';
import { approve, isGuardedQuery } from '../approve.js';
import type { ChartSpec } from '../plan/types.js';
import { CHART_KINDS } from '../plan/types.js';
import { quoteLiteral } from '../sql.js';
import type { AdminSource } from '../types.js';
import { cacheKey } from './key.js';
import { APPROVED_QUERY_TABLE, DEFAULT_METADATA_SCHEMA, quoteSchema, relation } from './names.js';
import type { CachedPlan, CacheKeyInput, RejectedEntry, SavedPlan, SavePlanInput } from './types.js';
import { StoreError } from './types.js';
import type { WriteOptions } from './write.js';
import { composeStatement, inWriteTransaction } from './write.js';

export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024;

const MAX_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const MAX_TENANT_LENGTH = 256;
const UNDEFINED_RELATION: ReadonlySet<string> = new Set(['42P01', '3F000']);
const TEXT = new TextEncoder();

export interface QueryStoreOptions extends WriteOptions {
  readonly schema?: string;
  /** null keeps an entry until the schema digest or an explicit invalidation retires it. */
  readonly ttlMs?: number | null;
  readonly maxEntryBytes?: number;
  /** The policy a restored plan is re-approved against. Tightening it retires stale plans. */
  readonly policy?: Policy;
  /** A hit updates hit_count and last_used_at in the same statement that reads it. */
  readonly touchOnHit?: boolean;
  readonly onRejected?: (event: RejectedEntry) => void;
}

export interface QueryStore {
  readonly schema: string;
  save(input: SavePlanInput): Promise<SavedPlan>;
  lookup(input: CacheKeyInput): Promise<CachedPlan | null>;
  invalidate(input: CacheKeyInput | string): Promise<number>;
  invalidateAll(): Promise<number>;
  purgeExpired(): Promise<number>;
}

const bytes = (value: string): number => TEXT.encode(value).length;

const cell = (row: readonly unknown[], index: number): string | null => {
  const value = row[index];
  return value === null || value === undefined ? null : String(value);
};

const text = (row: readonly unknown[], index: number, what: string): string => {
  const value = cell(row, index);
  if (value === null) throw new StoreError('E_CONFIG', `stored entry is missing ${what}`);
  return value;
};

const canonicalChart = (chart: ChartSpec): string =>
  JSON.stringify({
    kind: chart.kind,
    x: chart.x,
    y: [...chart.y],
    series: chart.series,
    title: chart.title,
  });

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function readChart(raw: string): ChartSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (!CHART_KINDS.includes(c.kind as ChartSpec['kind'])) return null;
  if (!nullableString(c.x) || !nullableString(c.series) || !nullableString(c.title)) return null;
  if (!isStringArray(c.y)) return null;
  return {
    kind: c.kind as ChartSpec['kind'],
    x: c.x,
    y: c.y,
    series: c.series,
    title: c.title,
  };
}

const ttlExpression = (ttlMs: number | null): string => {
  if (ttlMs === null) return 'NULL';
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) {
    throw new RangeError(`ttlMs must be an integer between 1000 and ${MAX_TTL_MS} ms, got ${ttlMs}`);
  }
  return `now() + make_interval(secs => ${(ttlMs / 1000).toFixed(3)})`;
};

const missingTable = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && UNDEFINED_RELATION.has(code)) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /(relation|schema) .* does not exist/i.test(message);
};

export function createQueryStore(
  source: AdminSource,
  guard: Guard,
  options: QueryStoreOptions = {},
): QueryStore {
  const schema = options.schema ?? DEFAULT_METADATA_SCHEMA;
  quoteSchema(schema);
  const table = relation(schema, APPROVED_QUERY_TABLE);
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const touchOnHit = options.touchOnHit ?? true;
  const policy = options.policy;
  const projection =
    'key, question, sql, chart::text, created_at::text, last_used_at::text, hit_count::text, expires_at::text';

  const report = (event: RejectedEntry): void => {
    const hook = options.onRejected;
    if (hook === undefined) return;
    try {
      hook(event);
    } catch {
      // A host logger that throws must not fail the lookup it is reporting on.
    }
  };

  const write = async <T>(
    body: (run: (sql: string) => Promise<readonly (readonly unknown[])[]>) => Promise<T>,
  ): Promise<T> => {
    try {
      return await inWriteTransaction(
        source,
        schema,
        async (run) => body(async (sql) => (await run(composeStatement(sql, schema))).rows),
        options,
      );
    } catch (err) {
      if (missingTable(err)) {
        throw new StoreError(
          'E_NOT_MIGRATED',
          `${schema}.${APPROVED_QUERY_TABLE} does not exist; migrations are never run automatically, so run ik migrate or runMigrations first`,
          { cause: err },
        );
      }
      throw err;
    }
  };

  const restore = (row: readonly unknown[]): CachedPlan | null => {
    const key = text(row, 0, 'key');
    const stored = text(row, 2, 'sql');
    const approval = policy === undefined ? approve(guard, stored) : approve(guard, stored, policy);
    if (!approval.ok) {
      report({ key, reason: 'denied', code: approval.code, detail: approval.detail });
      return null;
    }
    const chart = readChart(text(row, 3, 'chart'));
    if (chart === null) {
      report({ key, reason: 'invalid_chart', code: null, detail: 'stored chart is not a ChartSpec' });
      return null;
    }
    return {
      key,
      question: text(row, 1, 'question'),
      sql: approval.query.sql,
      query: approval.query,
      chart,
      createdAt: text(row, 4, 'created_at'),
      lastUsedAt: text(row, 5, 'last_used_at'),
      hitCount: Number(text(row, 6, 'hit_count')),
      expiresAt: cell(row, 7),
    };
  };

  return {
    schema,

    async save(input) {
      if (!isGuardedQuery(input.query)) {
        throw new StoreError(
          'E_NOT_APPROVED',
          'the store only records a query produced by approve; it was handed a plain object',
        );
      }
      const id = cacheKey(input.key);
      const chartJson = canonicalChart(input.chart);
      const tablesJson = JSON.stringify(
        input.query.tables.map((t) => ({ schema: t.schema ?? null, name: t.name })),
      );
      const size = bytes(id.question) + bytes(input.query.sql) + bytes(chartJson) + bytes(tablesJson);
      if (size > maxEntryBytes) {
        throw new StoreError(
          'E_ENTRY_TOO_LARGE',
          `entry is ${size} bytes, over the ${maxEntryBytes} byte cap; the metadata schema is a cache, not storage`,
        );
      }
      const tenant = input.tenantId ?? null;
      if (tenant !== null && tenant.length > MAX_TENANT_LENGTH) {
        throw new RangeError(`tenantId must be at most ${MAX_TENANT_LENGTH} characters`);
      }
      const rowLimit = input.query.rowLimit;
      if (rowLimit !== null && !Number.isInteger(rowLimit)) {
        throw new RangeError(`rowLimit must be an integer or null, got ${rowLimit}`);
      }

      const values = [
        quoteLiteral(id.key, 'cache key'),
        quoteLiteral(id.question, 'question'),
        quoteLiteral(input.query.sql, 'sql'),
        `${quoteLiteral(chartJson, 'chart')}::jsonb`,
        `${quoteLiteral(tablesJson, 'tables')}::jsonb`,
        rowLimit === null ? 'NULL' : String(rowLimit),
        quoteLiteral(id.schemaDigest, 'schema digest'),
        quoteLiteral(id.glossaryDigest, 'glossary digest'),
        quoteLiteral(id.plannerVersion, 'planner version'),
        tenant === null ? 'NULL' : quoteLiteral(tenant, 'tenant id'),
        ttlExpression(ttlMs),
      ].join(', ');

      const rows = await write((run) =>
        run(`INSERT INTO ${table}
  (key, question, sql, chart, tables, row_limit, schema_digest, glossary_digest, planner_version, created_for_tenant, expires_at)
VALUES (${values})
ON CONFLICT (key) DO UPDATE SET
  question = EXCLUDED.question, sql = EXCLUDED.sql, chart = EXCLUDED.chart, tables = EXCLUDED.tables,
  row_limit = EXCLUDED.row_limit, created_for_tenant = EXCLUDED.created_for_tenant,
  expires_at = EXCLUDED.expires_at, last_used_at = now()
RETURNING key, created_at::text, expires_at::text`),
      );

      const row = rows[0];
      if (row === undefined) throw new StoreError('E_CONFIG', 'the insert returned no row');
      return { key: text(row, 0, 'key'), createdAt: text(row, 1, 'created_at'), expiresAt: cell(row, 2) };
    },

    async lookup(input) {
      const id = cacheKey(input);
      const live = `key = ${quoteLiteral(id.key, 'cache key')} AND (expires_at IS NULL OR expires_at > now())`;
      const sql = touchOnHit
        ? `UPDATE ${table} SET hit_count = hit_count + 1, last_used_at = now() WHERE ${live} RETURNING ${projection}`
        : `SELECT ${projection} FROM ${table} WHERE ${live}`;

      const rows = await write((run) => run(sql));
      const row = rows[0];
      // An absent or expired entry is a miss. Only a present one that fails the guard is an event.
      return row === undefined ? null : restore(row);
    },

    async invalidate(input) {
      const key = typeof input === 'string' ? input : cacheKey(input).key;
      const rows = await write((run) =>
        run(`DELETE FROM ${table} WHERE key = ${quoteLiteral(key, 'cache key')} RETURNING key`),
      );
      return rows.length;
    },

    async invalidateAll() {
      const rows = await write((run) => run(`DELETE FROM ${table} RETURNING key`));
      return rows.length;
    },

    async purgeExpired() {
      const rows = await write((run) =>
        run(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING key`),
      );
      return rows.length;
    },
  };
}
