import type { DatabaseSchema, IntrospectOptions, ReadOptions } from '@insightkit/core';
import { asReaderSource, introspectSchema, renderDatabase } from '@insightkit/core';
import type { FlagSpecs } from '../args.js';
import { parseFlags, takeFlag, takeList, takeNumber, takeString } from '../args.js';
import type { Env, Opener } from '../connect.js';
import { closeQuietly } from '../connect.js';
import { CannotRunError, EXIT_OK, messageOf } from '../errors.js';
import { INTROSPECT_HELP } from '../help.js';
import type { Output } from '../output.js';

const SPECS = {
  'url-env': { type: 'string' },
  schema: { type: 'string', multiple: true },
  'exclude-schema': { type: 'string', multiple: true },
  'meta-schema': { type: 'string' },
  'max-tables': { type: 'string' },
  'max-columns': { type: 'string' },
  'statement-timeout': { type: 'string' },
  timeout: { type: 'string' },
  'no-comments': { type: 'boolean' },
  'no-row-counts': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies FlagSpecs;

export interface IntrospectDeps {
  readonly out: Output;
  readonly open: Opener;
  readonly env: Env;
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

export async function runIntrospect(argv: readonly string[], deps: IntrospectDeps): Promise<number> {
  const flags = parseFlags(argv, SPECS);
  const emit = (line: string): void => {
    deps.out.out(line);
  };

  if (takeFlag(flags, 'help')) {
    for (const line of INTROSPECT_HELP) emit(line);
    return EXIT_OK;
  }

  const metadataSchema = takeString(flags, 'meta-schema', 'insightkit');
  const restrictTo = takeList(flags, 'schema');
  const maxTables = takeNumber(flags, 'max-tables', 200, 1, 10_000);
  const maxColumns = takeNumber(flags, 'max-columns', 5000, 1, 200_000);

  const options: IntrospectOptions = {
    excludeSchemas: [...new Set([metadataSchema, ...takeList(flags, 'exclude-schema')])],
    maxTables,
    maxColumns,
    ...(restrictTo.length > 0 ? { schemas: restrictTo } : {}),
  };
  const readOptions: ReadOptions = {
    statementTimeoutMs: takeNumber(flags, 'statement-timeout', 15_000, 100, 600_000),
  };

  const connection = await deps.open({
    urlEnv: takeString(flags, 'url-env', 'DATABASE_URL'),
    timeoutMs: takeNumber(flags, 'timeout', 10_000, 100, 600_000),
    env: deps.env,
  });

  let schema: DatabaseSchema;
  try {
    schema = await introspectSchema(asReaderSource(connection.source), options, readOptions);
  } catch (err) {
    throw new CannotRunError(
      `could not read the catalog on ${connection.label}: ${connection.scrub(messageOf(err))}`,
    );
  } finally {
    await closeQuietly(connection, deps.out);
  }

  const safe = connection.scrubSecrets;
  emit(`-- schema visible to ${safe(schema.observedAs)} on ${connection.label}`);
  emit(`-- ${count(schema.tables.length, 'table')}, ${count(schema.foreignKeys.length, 'foreign key')}`);
  if (schema.truncated) {
    emit(`-- TRUNCATED at --max-tables ${maxTables} / --max-columns ${maxColumns}. This is a`);
    emit('-- subset of what the role can read, and the model would be told the same subset.');
  }
  emit('');

  if (schema.tables.length === 0) {
    emit(`-- Nothing is visible to ${safe(schema.observedAs)} here. Either the grants in ik init`);
    emit('-- were never applied, or --schema and --exclude-schema ruled everything out.');
    return EXIT_OK;
  }

  // Only the exact URL and password are stripped. A structural pass would rewrite a
  // column called token_expires_at and silently corrupt what the model gets told.
  emit(
    safe(
      renderDatabase(schema, {
        includeComments: !takeFlag(flags, 'no-comments'),
        includeRowCounts: !takeFlag(flags, 'no-row-counts'),
      }),
    ),
  );
  return EXIT_OK;
}
