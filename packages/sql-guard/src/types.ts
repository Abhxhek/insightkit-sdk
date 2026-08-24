export type DenyCode =
  | 'E_PARSE'
  | 'E_EMPTY'
  | 'E_NUL_BYTE'
  | 'E_MULTI_STATEMENT'
  | 'E_NOT_SELECT'
  | 'E_NODE_NOT_ALLOWED'
  | 'E_FIELD_NOT_ALLOWED'
  | 'E_FUNCTION_NOT_ALLOWED'
  | 'E_SCHEMA_NOT_ALLOWED'
  | 'E_TABLE_NOT_ALLOWED'
  | 'E_DEPTH_EXCEEDED'
  | 'E_ROUND_TRIP_FAILED'
  | 'E_INTERNAL';

export interface TableRef {
  schema: string | null;
  name: string;
}

export interface Policy {
  allowedSchemas?: readonly string[];
  allowedTables?: readonly string[];
  maxDepth?: number;
}

export type Verdict =
  | { readonly ok: true; readonly sql: string; readonly tables: readonly TableRef[] }
  | { readonly ok: false; readonly code: DenyCode; readonly detail: string };

export type Guard = (sql: string, policy?: Policy) => Verdict;
