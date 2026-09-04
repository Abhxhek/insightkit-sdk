import { assertIdent, quoteIdent, quoteLiteral } from './sql.js';

export interface ProvisionConfig {
  readonly database: string;
  readonly analyticsSchema: string;
  readonly appOwner: string;
  readonly readerRole: string;
  readonly loginRole: string;
  readonly metaRole: string;
  readonly metadataSchema: string;
  readonly connectionLimit: number;
  readonly validUntil: string;
}

export interface ProvisionScript {
  readonly scoped: readonly string[];
  readonly clusterWide: readonly string[];
}

const VALID_UNTIL = /^\d{4}-\d{2}-\d{2}$/;

export function provisioningScript(config: ProvisionConfig): ProvisionScript {
  const db = quoteIdent(config.database, 'database');
  const schema = quoteIdent(config.analyticsSchema, 'analytics schema');
  const owner = quoteIdent(config.appOwner, 'app owner');
  const reader = quoteIdent(config.readerRole, 'reader role');
  const login = quoteIdent(config.loginRole, 'login role');
  const meta = quoteIdent(config.metaRole, 'metadata role');
  const metaSchema = quoteIdent(config.metadataSchema, 'metadata schema');

  if (!Number.isInteger(config.connectionLimit) || config.connectionLimit < 1) {
    throw new RangeError(`connectionLimit must be a positive integer, got ${config.connectionLimit}`);
  }
  if (!VALID_UNTIL.test(config.validUntil)) {
    throw new RangeError(`validUntil must be YYYY-MM-DD, got ${JSON.stringify(config.validUntil)}`);
  }
  assertIdent(config.readerRole, 'reader role');

  const attributes = (role: string): string =>
    `ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;

  const scoped = [
    `CREATE ROLE ${reader} NOLOGIN`,
    `CREATE ROLE ${login} LOGIN IN ROLE ${reader} CONNECTION LIMIT ${config.connectionLimit} VALID UNTIL ${quoteLiteral(config.validUntil, 'validUntil')}`,
    attributes(reader),
    attributes(login),

    `CREATE ROLE ${meta} LOGIN CONNECTION LIMIT ${config.connectionLimit}`,
    attributes(meta),
    `CREATE SCHEMA ${metaSchema} AUTHORIZATION ${meta}`,
    `REVOKE ALL ON SCHEMA ${metaSchema} FROM PUBLIC`,
    `GRANT USAGE, CREATE ON SCHEMA ${metaSchema} TO ${meta}`,
    `REVOKE ALL ON SCHEMA ${metaSchema} FROM ${reader}`,

    `GRANT CONNECT ON DATABASE ${db} TO ${reader}`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${reader}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${reader}`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${reader}`,
    `REVOKE CREATE ON SCHEMA ${schema} FROM ${reader}`,

    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${reader}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT SELECT ON SEQUENCES TO ${reader}`,

    `ALTER ROLE ${login} SET search_path = pg_catalog, ${config.analyticsSchema}`,
    `ALTER ROLE ${login} SET default_transaction_read_only = on`,
    `ALTER ROLE ${login} SET statement_timeout = '15s'`,
    `ALTER ROLE ${login} SET lock_timeout = '2s'`,
    `ALTER ROLE ${login} SET idle_in_transaction_session_timeout = '30s'`,
    `ALTER ROLE ${login} SET row_security = on`,
    `ALTER ROLE ${login} SET jit = off`,
    `ALTER ROLE ${meta} SET search_path = pg_catalog, ${config.metadataSchema}`,
    `ALTER ROLE ${meta} SET statement_timeout = '10s'`,
    `ALTER ROLE ${meta} SET lock_timeout = '2s'`,
  ];

  const clusterWide = [
    `REVOKE TEMPORARY ON DATABASE ${db} FROM PUBLIC`,
    `REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`,
    `REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA ${schema} FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} REVOKE EXECUTE ON ROUTINES FROM PUBLIC`,
    `REVOKE SELECT ON pg_catalog.pg_stats FROM PUBLIC, ${reader}`,
  ];

  return { scoped, clusterWide };
}
