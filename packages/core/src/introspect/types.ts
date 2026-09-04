export type TableKind = 'table' | 'view' | 'materialized view' | 'partitioned table' | 'foreign table';

export interface ColumnInfo {
  readonly name: string;
  readonly dataType: string;
  readonly typeOid: number;
  readonly nullable: boolean;
  readonly comment: string | null;
}

export interface TableInfo {
  readonly schema: string;
  readonly name: string;
  readonly kind: TableKind;
  readonly comment: string | null;
  readonly estimatedRows: number;
  readonly columns: readonly ColumnInfo[];
  readonly primaryKey: readonly string[];
}

export interface ForeignKeyEnd {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
}

export interface ForeignKey {
  readonly name: string;
  readonly from: ForeignKeyEnd;
  readonly to: ForeignKeyEnd;
}

export interface DatabaseSchema {
  /** The role whose SELECT privilege decided what appears here. */
  readonly observedAs: string;
  readonly tables: readonly TableInfo[];
  readonly foreignKeys: readonly ForeignKey[];
  /** A cap was reached, so this is a subset of what the role can read. */
  readonly truncated: boolean;
}

export interface IntrospectOptions {
  /** Restrict to these schemas. Omitted means every non-system schema. */
  readonly schemas?: readonly string[];
  /** Never describe these. The metadata schema belongs here. */
  readonly excludeSchemas?: readonly string[];
  /**
   * Whose visibility to report. Omitted means the connected role, which is correct
   * when introspecting over the reader connection.
   */
  readonly asRole?: string;
  readonly maxTables?: number;
  readonly maxColumns?: number;
}
