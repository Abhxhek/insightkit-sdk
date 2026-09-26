#!/usr/bin/env node
import { runCli } from './cli.js';
import { openDatabase } from './connect.js';
import { processOutput } from './output.js';

// process.exitCode rather than process.exit: exit() drops whatever stdout has not
// flushed, which truncates the DDL the moment introspect is piped anywhere.
process.exitCode = await runCli(process.argv.slice(2), {
  out: processOutput(),
  env: process.env,
  now: new Date(),
  open: openDatabase,
});
