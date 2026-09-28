import { inReadOnlyTransaction } from '../session.js';
import { isAdminSource } from '../source.js';
import { quoteIdent, quoteLiteral } from '../sql.js';
import type { AdminSource } from '../types.js';
import { contentHash } from './key.js';
import {
  APPROVED_QUERY_TABLE,
  DEFAULT_METADATA_SCHEMA,
  MIGRATION_TABLE,
  quoteSchema,
  relation,
} from './names.js';
import { StoreError } from './types.js';
import type { WriteOptions } from './write.js';
import { composeStatement, inWriteTransaction } from './write.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: (schema: string) => readonly string[];
}

export interface MigrationOptions extends WriteOptions {
  readonly schema?: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
}

export interface MigrationReport {
  readonly schema: string;
  readonly bootstrapped: boolean;
  readonly applied: readonly AppliedMigration[];
  readonly alreadyApplied: readonly number[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'approved_query',
    statements: (schema) => {
      const table = relation(schema, APPROVED_QUERY_TABLE);
      return [
        `CREATE TABLE IF NOT EXISTS ${table} (
  key text PRIMARY KEY,
  question text NOT NULL,
  sql text NOT NULL,
  chart jsonb NOT NULL,
  tables jsonb NOT NULL,
  row_limit integer,
  schema_digest text NOT NULL,
  glossary_digest text NOT NULL,
  planner_version text NOT NULL,
  created_for_tenant text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  hit_count bigint NOT NULL DEFAULT 0,
  expires_at timestamptz
)`,
        `CREATE INDEX IF NOT EXISTS ${quoteIdent('approved_query_schema_digest_idx', 'index')} ON ${table} (schema_digest)`,
        `CREATE INDEX IF NOT EXISTS ${quoteIdent('approved_query_expires_at_idx', 'index')} ON ${table} (expires_at)`,
      ];
    },
  },
];

export function bootstrapStatements(schema: string): readonly string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${quoteSchema(schema)}`,
    `CREATE TABLE IF NOT EXISTS ${relation(schema, MIGRATION_TABLE)} (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`,
  ];
}

export const migrationChecksum = (migration: Migration, schema: string): string =>
  contentHash(migration.statements(schema).join('\n;\n'));

const existsStatement = (schema: string): string =>
  `SELECT to_regclass(${quoteLiteral(`${quoteSchema(schema)}.${quoteIdent(MIGRATION_TABLE, 'metadata table')}`, 'migration table')})::text`;

const ledgerStatement = (schema: string): string =>
  `SELECT version::text, name, checksum FROM ${relation(schema, MIGRATION_TABLE)} ORDER BY version`;

const recordStatement = (migration: Migration, schema: string): string => {
  if (!Number.isInteger(migration.version) || migration.version < 1) {
    throw new RangeError(`migration version must be a positive integer, got ${migration.version}`);
  }
  return `INSERT INTO ${relation(schema, MIGRATION_TABLE)} (version, name, checksum) VALUES (${migration.version}, ${quoteLiteral(migration.name, 'migration name')}, ${quoteLiteral(migrationChecksum(migration, schema), 'migration checksum')})`;
};

interface LedgerRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

const readLedger = (rows: readonly (readonly unknown[])[]): readonly LedgerRow[] =>
  rows.map((row) => ({
    version: Number(String(row[0] ?? '')),
    name: String(row[1] ?? ''),
    checksum: String(row[2] ?? ''),
  }));

function reconcile(schema: string, ledger: readonly LedgerRow[]): readonly Migration[] {
  const known = new Map(MIGRATIONS.map((m) => [m.version, m]));
  for (const row of ledger) {
    const migration = known.get(row.version);
    if (migration === undefined) {
      throw new StoreError(
        'E_MIGRATION_AHEAD',
        `${schema} holds migration ${row.version} (${row.name}), which this version of InsightKit does not know; upgrade rather than downgrade`,
      );
    }
    const expected = migrationChecksum(migration, schema);
    if (row.checksum !== expected) {
      throw new StoreError(
        'E_MIGRATION_CHECKSUM',
        `migration ${row.version} (${migration.name}) was applied from different DDL than this build carries; the metadata schema and the code disagree`,
      );
    }
  }
  const done = new Set(ledger.map((r) => r.version));
  return MIGRATIONS.filter((m) => !done.has(m.version));
}

/**
 * Read-only inspection, so `ik migrate --check` and a startup assertion cost nothing and
 * change nothing. Needs the admin source because the reader cannot see the schema at all.
 */
export async function pendingMigrations(
  source: AdminSource,
  options: MigrationOptions = {},
): Promise<readonly Migration[]> {
  if (!isAdminSource(source)) {
    throw new TypeError('pendingMigrations requires a source produced by asAdminSource');
  }
  const schema = options.schema ?? DEFAULT_METADATA_SCHEMA;
  return inReadOnlyTransaction(source, async (ask) => {
    const exists = await ask(composeStatement(existsStatement(schema), schema).text);
    if (exists.rows[0]?.[0] == null) return MIGRATIONS;
    const ledger = await ask(composeStatement(ledgerStatement(schema), schema).text);
    return reconcile(schema, readLedger(ledger.rows));
  });
}

/**
 * Deliberate, never automatic. Creating a schema and tables inside somebody else's
 * production database on an import or a first request is a change their change log cannot
 * explain, and it is indistinguishable from an intrusion. `ik migrate` or this call.
 */
export async function runMigrations(
  source: AdminSource,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const schema = options.schema ?? DEFAULT_METADATA_SCHEMA;
  quoteSchema(schema);

  return inWriteTransaction(
    source,
    schema,
    async (run) => {
      const exists = await run(composeStatement(existsStatement(schema), schema));
      const bootstrapped = exists.rows[0]?.[0] == null;

      let ledger: readonly LedgerRow[] = [];
      if (bootstrapped) {
        for (const text of bootstrapStatements(schema)) await run(composeStatement(text, schema));
      } else {
        const rows = await run(composeStatement(ledgerStatement(schema), schema));
        ledger = readLedger(rows.rows);
      }

      const pending = reconcile(schema, ledger);
      for (const migration of pending) {
        for (const text of migration.statements(schema)) await run(composeStatement(text, schema));
        await run(composeStatement(recordStatement(migration, schema), schema));
      }

      return {
        schema,
        bootstrapped,
        applied: pending.map((m) => ({ version: m.version, name: m.name })),
        alreadyApplied: ledger.map((r) => r.version),
      };
    },
    options,
  );
}
