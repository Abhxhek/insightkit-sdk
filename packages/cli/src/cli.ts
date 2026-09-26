import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { runIntrospect } from './commands/introspect.js';
import type { Env, Opener } from './connect.js';
import { CannotRunError, EXIT_CANNOT_RUN, EXIT_OK, EXIT_USAGE, messageOf, UsageError } from './errors.js';
import { CLI_HELP } from './help.js';
import type { Output } from './output.js';
import { redact } from './redact.js';
import { version } from './version.js';

export interface CliDeps {
  readonly out: Output;
  readonly env: Env;
  readonly now: Date;
  readonly open: Opener;
}

const COMMANDS = ['init', 'doctor', 'introspect'] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string): value is Command => (COMMANDS as readonly string[]).includes(value);

function fail(err: unknown, command: Command, deps: CliDeps): number {
  if (err instanceof UsageError) {
    deps.out.err(`ik ${command}: ${redact(err.message)}`);
    deps.out.err(`Run 'ik ${command} --help'.`);
    return EXIT_USAGE;
  }
  if (err instanceof CannotRunError) {
    // Already scrubbed where it was raised. Redacting again rewrites the example URL
    // in the guidance into postgres://[redacted]@host, which teaches nobody anything.
    deps.out.err(`ik ${command}: ${err.message}`);
    return EXIT_CANNOT_RUN;
  }

  deps.out.err(`ik ${command}: ${redact(messageOf(err))}`);
  deps.out.err('This is a bug in ik, not a finding about your database.');
  if (deps.env.IK_DEBUG !== undefined && err instanceof Error && err.stack !== undefined) {
    deps.out.err(redact(err.stack));
  } else {
    deps.out.err('Set IK_DEBUG=1 for the stack trace.');
  }
  return EXIT_CANNOT_RUN;
}

/** Never throws: every failure leaves here as a line on stderr and an exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [first, ...rest] = argv;

  if (first === undefined) {
    for (const line of CLI_HELP) deps.out.err(line);
    return EXIT_USAGE;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    for (const line of CLI_HELP) deps.out.out(line);
    return EXIT_OK;
  }
  if (first === '--version' || first === '-v') {
    deps.out.out(version());
    return EXIT_OK;
  }
  if (!isCommand(first)) {
    deps.out.err(`ik: no command called ${JSON.stringify(first)}. Expected ${COMMANDS.join(', ')}.`);
    deps.out.err("Run 'ik --help'.");
    return EXIT_USAGE;
  }

  try {
    if (first === 'init') return runInit(rest, { out: deps.out, now: deps.now });
    const commandDeps = { out: deps.out, open: deps.open, env: deps.env };
    return first === 'doctor' ? await runDoctor(rest, commandDeps) : await runIntrospect(rest, commandDeps);
  } catch (err) {
    return fail(err, first, deps);
  }
}
