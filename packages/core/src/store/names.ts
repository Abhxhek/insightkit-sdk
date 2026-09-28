import { quoteIdent } from '../sql.js';

export const DEFAULT_METADATA_SCHEMA = 'insightkit';
export const MIGRATION_TABLE = 'schema_migrations';
export const APPROVED_QUERY_TABLE = 'approved_query';

export const quoteSchema = (schema: string): string => quoteIdent(schema, 'metadata schema');

export function relation(schema: string, table: string): string {
  return `${quoteSchema(schema)}.${quoteIdent(table, 'metadata table')}`;
}
