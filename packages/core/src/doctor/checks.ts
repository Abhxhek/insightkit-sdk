import { assertIdent, quoteLiteral } from '../sql.js';
import type { Check, CheckOutcome } from '../types.js';

export interface RoleNames {
  readonly reader: string;
  readonly login: string;
  readonly metadataSchema: string;
}

const pass = (detail: string): CheckOutcome => ({ status: 'pass', detail });
const fail = (detail: string): CheckOutcome => ({ status: 'fail', detail });
const review = (detail: string): CheckOutcome => ({ status: 'review', detail });

const describe = (rows: readonly (readonly unknown[])[], limit = 5): string => {
  const head = rows
    .slice(0, limit)
    .map((r) => r.map((c) => String(c)).join('.'))
    .join('; ');
  return rows.length > limit ? `${head} (+${rows.length - limit} more)` : head;
};

export function isolationChecks(roles: RoleNames): readonly Check[] {
  const reader = quoteLiteral(assertIdent(roles.reader, 'reader role'), 'reader role');
  const login = quoteLiteral(assertIdent(roles.login, 'login role'), 'login role');
  const meta = quoteLiteral(assertIdent(roles.metadataSchema, 'metadata schema'), 'metadata schema');
  const both = `${reader}, ${login}`;

  return [
    {
      id: 'A0',
      title: 'the proof is not being run as a role it is testing',
      blocking: true,
      sql: 'SELECT current_user',
      evaluate: (rows) => {
        const who = String(rows[0]?.[0] ?? '');
        return who === roles.reader || who === roles.login
          ? fail(`running as ${who}, a role under test; privilege views under-report from inside`)
          : pass(`running as ${who}`);
      },
    },
    {
      id: 'A1',
      title: 'the reader holds no write privilege on any table',
      blocking: true,
      sql: `SELECT table_schema, table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee IN (${both}) AND privilege_type <> 'SELECT'`,
      evaluate: (rows) =>
        rows.length === 0
          ? pass('no non-SELECT table privilege')
          : fail(`${rows.length} write privilege(s): ${describe(rows)}`),
    },
    {
      id: 'A2',
      title: 'the reader holds no predefined-role membership',
      blocking: true,
      sql: `SELECT r.rolname
FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.roleid
JOIN pg_roles g ON g.oid = m.member
WHERE g.rolname IN (${both}) AND r.rolname LIKE 'pg\\_%'`,
      evaluate: (rows) =>
        rows.length === 0 ? pass('no pg_ role membership') : fail(`member of ${describe(rows)}`),
    },
    {
      id: 'A3',
      title: 'the reader carries none of the attributes that defeat every other layer',
      blocking: true,
      sql: `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
FROM pg_roles WHERE rolname IN (${both})`,
      evaluate: (rows) => {
        if (rows.length === 0) return fail('neither role exists');
        const bad = rows.filter((r) => r.slice(1).some((flag) => flag === true));
        return bad.length === 0
          ? pass(`${rows.length} role(s) clean`)
          : fail(`dangerous attribute set on ${describe(bad)}`);
      },
    },
    {
      id: 'A4',
      title: 'the reader cannot see the metadata schema, which holds prompts and query history',
      blocking: true,
      sql: `SELECT COALESCE(
  (SELECT has_schema_privilege(${login}, n.oid, 'USAGE') FROM pg_namespace n WHERE n.nspname = ${meta}),
  false)`,
      evaluate: (rows) =>
        rows[0]?.[0] === true
          ? fail(`${roles.login} has USAGE on ${roles.metadataSchema}`)
          : pass('metadata schema not reachable by the reader'),
    },
    {
      id: 'B1',
      title: 'SECURITY DEFINER functions the reader may execute',
      blocking: false,
      sql: `SELECT n.nspname, p.proname, pg_get_userbyid(p.proowner) AS owner
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef AND has_function_privilege(${login}, p.oid, 'EXECUTE')`,
      evaluate: (rows) =>
        rows.length === 0
          ? pass('none reachable')
          : review(
              `${rows.length} reachable; each body runs as its owner and is invisible to the guard: ${describe(rows)}`,
            ),
    },
    {
      id: 'B2',
      title: 'views and materialised views the reader may read',
      blocking: false,
      sql: `SELECT c.relnamespace::regnamespace::text AS schema, c.relname
FROM pg_class c
WHERE c.relkind IN ('v','m') AND has_table_privilege(${login}, c.oid, 'SELECT')`,
      evaluate: (rows) =>
        rows.length === 0
          ? pass('none readable')
          : review(
              `${rows.length} readable; bodies expand server-side and are invisible to the guard: ${describe(rows)}`,
            ),
    },
    {
      id: 'B3',
      title: 'extensions providing network, file or untrusted-language escape hatches',
      blocking: false,
      sql: `SELECT extname FROM pg_extension
WHERE extname IN ('dblink','postgres_fdw','file_fdw','plpython3u','plperlu','http','xml2')`,
      evaluate: (rows) =>
        rows.length === 0 ? pass('none installed') : review(`installed: ${describe(rows)}`),
    },
  ];
}
