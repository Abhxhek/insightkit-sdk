import type { ProvisionConfig, ProvisionScript } from '@insightkit/core';
import { provisioningScript } from '@insightkit/core';
import type { FlagSpecs } from '../args.js';
import { parseFlags, takeFlag, takeNumber, takeString } from '../args.js';
import { EXIT_OK, messageOf, UsageError } from '../errors.js';
import { INIT_HELP } from '../help.js';
import type { Output } from '../output.js';

const SPECS = {
  database: { type: 'string' },
  schema: { type: 'string' },
  owner: { type: 'string' },
  reader: { type: 'string' },
  login: { type: 'string' },
  'meta-role': { type: 'string' },
  'meta-schema': { type: 'string' },
  'connection-limit': { type: 'string' },
  'valid-until': { type: 'string' },
  'scoped-only': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies FlagSpecs;

export interface InitDeps {
  readonly out: Output;
  readonly now: Date;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const BAR = `-- ${'-'.repeat(74)}`;

const oneYearOn = (now: Date): string => new Date(now.getTime() + YEAR_MS).toISOString().slice(0, 10);

export function runInit(argv: readonly string[], deps: InitDeps): number {
  const flags = parseFlags(argv, SPECS);
  const emit = (line: string): void => {
    deps.out.out(line);
  };

  if (takeFlag(flags, 'help')) {
    for (const line of INIT_HELP) emit(line);
    return EXIT_OK;
  }

  const config: ProvisionConfig = {
    database: takeString(flags, 'database', 'postgres'),
    analyticsSchema: takeString(flags, 'schema', 'public'),
    appOwner: takeString(flags, 'owner', 'postgres'),
    readerRole: takeString(flags, 'reader', 'ik_reader'),
    loginRole: takeString(flags, 'login', 'ik_sdk'),
    metaRole: takeString(flags, 'meta-role', 'ik_meta'),
    metadataSchema: takeString(flags, 'meta-schema', 'insightkit'),
    connectionLimit: takeNumber(flags, 'connection-limit', 5, 1, 1000),
    validUntil: takeString(flags, 'valid-until', oneYearOn(deps.now)),
  };

  let script: ProvisionScript;
  try {
    script = provisioningScript(config);
  } catch (err) {
    // core validates every identifier and the date; that is a bad flag, not a crash.
    throw new UsageError(messageOf(err));
  }

  emit(`-- InsightKit provisioning for database "${config.database}", schema "${config.analyticsSchema}".`);
  emit('--');
  emit('-- Run as a superuser, or as a role that may CREATE ROLE. Read section 2 first.');
  emit('--');
  emit('-- There is no password in this script, deliberately. A credential printed to a');
  emit('-- terminal lives on in scrollback and in the CI log, so set them separately:');
  emit(`--     \\password ${config.loginRole}`);
  emit(`--     \\password ${config.metaRole}`);
  emit('--');
  emit(`-- "${config.loginRole}" stops connecting on ${config.validUntil}, which is a hard expiry.`);
  emit('-- Pick another date with --valid-until.');
  emit('--');
  emit(`-- ALTER DEFAULT PRIVILEGES below names "${config.appOwner}" as the owner. That has to be`);
  emit(`-- the role that CREATEs tables in "${config.analyticsSchema}": if it is not, tables added`);
  emit('-- later are invisible to the reader and nothing reports it. Set it with --owner.');
  emit('');
  emit(BAR);
  emit("-- 1. SCOPED. Touches only InsightKit's own roles and schemas.");
  emit(BAR);
  emit('');
  for (const statement of script.scoped) emit(`${statement};`);
  emit('');

  if (takeFlag(flags, 'scoped-only')) {
    emit(`-- ${script.clusterWide.length} cluster-wide statements were left out by --scoped-only.`);
    deps.out.err(
      'ik init: --scoped-only left out the cluster-wide hardening. ik doctor does not check it, ' +
        'so a database that never runs it still proves clean.',
    );
  } else {
    emit(BAR);
    emit('-- 2. CLUSTER-WIDE. Changes privileges held by roles that are not ours.');
    emit('--');
    emit("-- PUBLIC is every role in this cluster, your application's own included. Read");
    emit('-- each line before running it.');
    emit('--');
    emit('-- Do not quietly drop the section either: none of it is covered by ik doctor,');
    emit('-- so a database that skips it proves clean while PUBLIC still holds the');
    emit('-- privileges the grants above were written to fence off.');
    emit(BAR);
    emit('');
    for (const statement of script.clusterWide) emit(`${statement};`);
    emit('');
  }

  emit('-- Then prove it against the live catalog, as an admin role and not as');
  emit(`-- "${config.loginRole}":`);
  emit(
    `--     DATABASE_URL=postgres://... ik doctor --reader ${config.readerRole}` +
      ` --login ${config.loginRole} --meta-schema ${config.metadataSchema}`,
  );

  const guessed = [
    flags.database === undefined ? '--database' : null,
    flags.owner === undefined ? '--owner' : null,
  ].filter((name): name is string => name !== null);
  if (guessed.length > 0) {
    deps.out.err(
      `ik init: assumed ${guessed.join(' and ')}. Pass them if "${config.database}" is not your ` +
        'database, or if your tables are owned by another role.',
    );
  }

  return EXIT_OK;
}
