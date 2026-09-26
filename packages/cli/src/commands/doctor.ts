import type { Check, CheckStatus, IsolationProof, RoleNames } from '@insightkit/core';
import { isolationChecks, proveIsolation } from '@insightkit/core';
import type { FlagSpecs } from '../args.js';
import { parseFlags, takeFlag, takeNumber, takeString } from '../args.js';
import type { Env, Opener } from '../connect.js';
import { closeQuietly } from '../connect.js';
import { CannotRunError, EXIT_NOT_PROVEN, EXIT_OK, messageOf, UsageError } from '../errors.js';
import { DOCTOR_HELP } from '../help.js';
import type { Output } from '../output.js';

const SPECS = {
  'url-env': { type: 'string' },
  reader: { type: 'string' },
  login: { type: 'string' },
  'meta-schema': { type: 'string' },
  timeout: { type: 'string' },
  strict: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies FlagSpecs;

export interface DoctorDeps {
  readonly out: Output;
  readonly open: Opener;
  readonly env: Env;
}

const BADGE: Readonly<Record<CheckStatus, string>> = {
  pass: 'PASS  ',
  fail: 'FAIL  ',
  review: 'REVIEW',
};

const INDENT = ' '.repeat(14);

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

export async function runDoctor(argv: readonly string[], deps: DoctorDeps): Promise<number> {
  const flags = parseFlags(argv, SPECS);
  const emit = (line: string): void => {
    deps.out.out(line);
  };

  if (takeFlag(flags, 'help')) {
    for (const line of DOCTOR_HELP) emit(line);
    return EXIT_OK;
  }

  const roles: RoleNames = {
    reader: takeString(flags, 'reader', 'ik_reader'),
    login: takeString(flags, 'login', 'ik_sdk'),
    metadataSchema: takeString(flags, 'meta-schema', 'insightkit'),
  };

  let checks: readonly Check[];
  try {
    checks = isolationChecks(roles);
  } catch (err) {
    throw new UsageError(messageOf(err));
  }

  const urlEnv = takeString(flags, 'url-env', 'DATABASE_URL');
  const timeoutMs = takeNumber(flags, 'timeout', 10_000, 100, 600_000);
  const strict = takeFlag(flags, 'strict');

  const connection = await deps.open({ urlEnv, timeoutMs, env: deps.env });
  let proof: IsolationProof;
  try {
    proof = await proveIsolation(connection.source, checks);
  } catch (err) {
    // Nothing was proven, which is a different outcome from a proof that failed.
    throw new CannotRunError(
      `could not run the proof against ${connection.label}: ${connection.scrub(messageOf(err))}`,
    );
  } finally {
    await closeQuietly(connection, deps.out);
  }

  emit(`InsightKit isolation proof - ${connection.label}`);
  emit(`roles under test: ${roles.reader}, ${roles.login}; metadata schema: ${roles.metadataSchema}`);
  emit('');

  // A detail is usually catalog text, but core folds a failed query's message into it,
  // and a driver message can quote the URL back.
  const safe = connection.scrubSecrets;

  for (const check of proof.checks) {
    emit(
      `  ${BADGE[check.status]}  ${check.id.padEnd(2)}  ${check.title}${check.blocking ? '' : '  (advisory)'}`,
    );
    emit(`${INDENT}${safe(check.detail)}`);
  }

  if (proof.blockers.length > 0) {
    emit('');
    emit('Blockers - the proof does not hold:');
    for (const blocker of proof.blockers) emit(`  - ${safe(blocker)}`);
    if (proof.blockers.some((b) => b.startsWith('A0:'))) {
      emit('');
      emit('  A0 means ik doctor connected as a role it is testing. The privilege views');
      emit('  under-report from inside, so nothing this run says about the other checks');
      emit('  can be trusted. Point the connection at an administrative role and re-run.');
    }
  }

  if (proof.needsReview.length > 0) {
    emit('');
    emit('Needs review - not blocking, but each one is invisible to the SQL guard:');
    for (const finding of proof.needsReview) emit(`  - ${safe(finding)}`);
  }

  const blocking = proof.checks.filter((c) => c.blocking).length;
  const strictTrip = strict && proof.needsReview.length > 0;
  emit('');

  if (proof.proven && !strictTrip) {
    const trailer =
      proof.needsReview.length > 0 ? ` ${count(proof.needsReview.length, 'finding')} needs review.` : '';
    emit(`PROVEN - ${count(blocking, 'blocking check')} passed.${trailer}`);
    return EXIT_OK;
  }

  if (proof.proven) {
    emit(
      `NOT PROVEN - every blocking check passed, but --strict fails on ` +
        `${count(proof.needsReview.length, 'review finding')}.`,
    );
  } else {
    emit(`NOT PROVEN - ${count(proof.blockers.length, 'blocking check')} of ${blocking} did not pass.`);
    emit('If the roles do not exist yet, run ik init; if yours have other names, pass');
    emit('--reader, --login and --meta-schema.');
  }
  return EXIT_NOT_PROVEN;
}
