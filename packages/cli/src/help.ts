const lines = (text: string): readonly string[] => text.replace(/^\n/, '').trimEnd().split('\n');

export const CLI_HELP = lines(`
ik - InsightKit's command line

Usage
  ik <command> [options]

Commands
  init         print the SQL a DBA runs to create InsightKit's roles and grants
  doctor       prove against the live catalog that the reader cannot write
  introspect   print the schema the reader can see, as DDL

Options
  -h, --help     this, or a command's own help with 'ik <command> --help'
  -v, --version  print the version

Exit codes
  0  the command did what it was asked
  1  'ik doctor' ran and the proof did not hold
  2  the arguments were wrong
  3  the command could not run at all: no connection URL, no pg driver, no
     connection, or a catalog query that never came back

'doctor' and 'introspect' read the connection URL from the environment, never
from a flag: an argument is visible in 'ps' and lands in shell history. Both are
read-only, and neither prints a URL, a user or a password.
`);

export const INIT_HELP = lines(`
ik init - print the provisioning SQL for InsightKit's roles

Usage
  ik init [options] > provision.sql

Prints runnable SQL and connects to nothing. The script holds no password, on
purpose: a credential printed to a terminal lives on in scrollback and in the CI
log. Set those separately with \\password.

Options
  --database <name>           database the reader connects to      [postgres]
  --schema <name>             schema holding the analytics tables  [public]
  --owner <role>              role that owns those tables          [postgres]
  --reader <role>             group role that holds SELECT         [ik_reader]
  --login <role>              login role the SDK connects as       [ik_sdk]
  --meta-role <role>          login role for InsightKit's metadata [ik_meta]
  --meta-schema <name>        schema holding that metadata         [insightkit]
  --connection-limit <n>      per-role connection cap              [5]
  --valid-until <YYYY-MM-DD>  expiry on the login role             [one year out]
  --scoped-only               omit the cluster-wide section
  -h, --help

The output is split into a scoped section, which touches only InsightKit's own
roles and schemas, and a cluster-wide section, which changes privileges held by
PUBLIC and therefore by every other role in the cluster.
`);

export const DOCTOR_HELP = lines(`
ik doctor - prove the reader is isolated, against the live catalog

Usage
  DATABASE_URL=postgres://... ik doctor [options]

Runs every isolation check inside a read-only transaction that is rolled back,
and writes nothing. Connect as an administrative role: check A0 fails when
'ik doctor' is run as a role it is testing, because the privilege views
under-report from inside and a proof taken there is worthless.

Options
  --url-env <NAME>      environment variable holding the URL  [DATABASE_URL]
  --reader <role>       group role that holds SELECT          [ik_reader]
  --login <role>        login role the SDK connects as        [ik_sdk]
  --meta-schema <name>  schema holding InsightKit's metadata  [insightkit]
  --timeout <ms>        connection timeout                    [10000]
  --strict              fail on review findings as well as blocking ones
  -h, --help

Exits 0 when the proof holds, 1 when it does not, and 3 when it could not run.
The exit code is the point: this is the command that belongs in CI.
`);

export const INTROSPECT_HELP = lines(`
ik introspect - print the schema the reader can see, as DDL

Usage
  DATABASE_URL=postgres://... ik introspect [options] > schema.sql

Describes only what the connected role may SELECT, which is exactly what the
model gets told. Read-only. The metadata schema is always excluded, because
describing it would put prompt and query history into a prompt.

Options
  --url-env <NAME>          environment variable holding the URL  [DATABASE_URL]
  --schema <name>           restrict to this schema, repeatable
  --exclude-schema <name>   skip this schema, repeatable
  --meta-schema <name>      always excluded                       [insightkit]
  --max-tables <n>          cap; truncation is reported, not hidden  [200]
  --max-columns <n>         cap; truncation is reported, not hidden  [5000]
  --statement-timeout <ms>  per catalog query                     [15000]
  --timeout <ms>            connection timeout                    [10000]
  --no-comments             leave out table and column comments
  --no-row-counts           leave out the row estimates
  -h, --help
`);
