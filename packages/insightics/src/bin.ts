#!/usr/bin/env node
import { openDatabase, processOutput, runCli } from 'insightics-cli';

// process.exitCode rather than process.exit: exit() drops whatever stdout has not
// flushed, which truncates the DDL the moment introspect is piped anywhere.
process.exitCode = await runCli(process.argv.slice(2), {
  out: processOutput(),
  env: process.env,
  now: new Date(),
  open: openDatabase,
});
