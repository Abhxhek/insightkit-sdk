import { types as driverTypes } from 'pg';
import type { ConnectionSource, QueryOutcome, SqlClient } from './types.js';

export interface PgField {
  readonly name: string;
  readonly dataTypeID: number;
  readonly format?: string;
}

export interface PgArrayResult {
  readonly fields: readonly PgField[];
  readonly rows: readonly (readonly unknown[])[];
}

export interface PgTypeRegistry {
  getTypeParser(oid: number, format?: string): (raw: string) => unknown;
}

export interface PgQueryConfig {
  readonly text: string;
  readonly rowMode: 'array';
  readonly types: PgTypeRegistry;
}

export interface PgClient {
  query(config: PgQueryConfig): Promise<PgArrayResult>;
  release(destroy?: boolean): void;
}

export interface PgPool {
  connect(): Promise<PgClient>;
  readonly options?: { readonly connectionTimeoutMillis?: number | undefined };
}

const asText = (raw: string): string => raw;

/**
 * Types whose node-postgres conversion loses or invents information. A `date` becomes
 * a Date at local midnight, so 2026-09-05 serialises to the 4th anywhere east of UTC;
 * a `timestamp` gains an offset it never carried; the numeric[] parser drops the
 * precision the scalar parser is careful to keep. Postgres already sent an unambiguous
 * string, so we keep it and let the presentation layer, which knows the viewer's
 * timezone, do the converting.
 */
const TEXT_OIDS: ReadonlySet<number> = new Set([
  17, 1001, 1082, 1182, 1083, 1183, 1114, 1115, 1184, 1185, 1186, 1187, 1266, 1270, 1231,
]);

export const FIDELITY_TYPES: PgTypeRegistry = {
  getTypeParser(oid, format) {
    if (TEXT_OIDS.has(oid)) return asText;
    if (format !== undefined && format !== 'text') return asText;
    return driverTypes.getTypeParser(oid) as (raw: string) => unknown;
  },
};

const toOutcome = (result: PgArrayResult): QueryOutcome => ({
  fields: result.fields.map((f) => ({ name: f.name })),
  rows: result.rows,
});

function sealClient(client: PgClient): SqlClient {
  let released = false;
  return {
    async query(text: string): Promise<QueryOutcome> {
      return toOutcome(await client.query({ text, rowMode: 'array', types: FIDELITY_TYPES }));
    },
    release(destroy?: boolean): void {
      // pg throws on a second release, which would mask whatever sent us here.
      if (released) return;
      released = true;
      client.release(destroy === true);
    },
  };
}

export function fromPgPool(pool: PgPool): ConnectionSource {
  if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') {
    throw new TypeError('fromPgPool requires a node-postgres Pool');
  }
  if (pool.options !== undefined && !((pool.options.connectionTimeoutMillis ?? 0) > 0)) {
    throw new RangeError(
      'the pool must set connectionTimeoutMillis: without it an exhausted pool waits forever, ' +
        'so a slow query turns every later request into a hang instead of an error',
    );
  }
  return { connect: async (): Promise<SqlClient> => sealClient(await pool.connect()) };
}
