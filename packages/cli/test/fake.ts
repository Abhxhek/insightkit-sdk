import type { ConnectionSource, SqlClient } from '@insightkit/core';
import type { CliDeps } from '../src/cli.js';
import type { Connection, Env, Opener, OpenOptions } from '../src/connect.js';
import type { Output } from '../src/output.js';
import { redactorFor, secretRedactorFor } from '../src/redact.js';

export const URL_WITH_SECRET = 'postgres://ik_admin:hunter2-correct-horse@db.internal:6432/shop';
export const PASSWORD = 'hunter2-correct-horse';
export const LABEL = 'db.internal:6432/shop';
export const FIXED_NOW = new Date('2026-09-27T09:00:00.000Z');

export type Answers = Readonly<Record<string, readonly (readonly unknown[])[]>>;

export interface FakeOptions {
  /** Any statement containing this throws, as a locked-down catalog would. */
  readonly failOn?: string;
  /** connect() rejects, so nothing runs at all. */
  readonly connectError?: string;
  readonly closeError?: string;
}

export interface FakeDatabase {
  readonly open: Opener;
  readonly log: readonly string[];
  readonly released: readonly boolean[];
  readonly opened: readonly OpenOptions[];
  readonly closes: readonly boolean[];
}

export function fakeDatabase(answers: Answers, options: FakeOptions = {}): FakeDatabase {
  const log: string[] = [];
  const released: boolean[] = [];
  const opened: OpenOptions[] = [];
  const closes: boolean[] = [];

  const client: SqlClient = {
    async query(text) {
      log.push(text);
      if (options.failOn !== undefined && text.includes(options.failOn)) {
        // Carries the URL on purpose: a real driver error can, and must be scrubbed.
        throw new Error(`permission denied for relation, while connected to ${URL_WITH_SECRET}`);
      }
      const hit = Object.entries(answers).find(([needle]) => text.includes(needle));
      return { fields: [], rows: hit?.[1] ?? [] };
    },
    release(destroy) {
      released.push(destroy === true);
    },
  };

  const source: ConnectionSource = {
    async connect() {
      if (options.connectError !== undefined) throw new Error(options.connectError);
      return client;
    },
  };

  const open: Opener = async (request) => {
    opened.push(request);
    const connection: Connection = {
      source,
      label: LABEL,
      scrub: redactorFor([URL_WITH_SECRET, PASSWORD]),
      scrubSecrets: secretRedactorFor([URL_WITH_SECRET, PASSWORD]),
      async close() {
        closes.push(true);
        if (options.closeError !== undefined) throw new Error(options.closeError);
      },
    };
    return connection;
  };

  return { open, log, released, opened, closes };
}

export const refuseToOpen: Opener = async () => {
  throw new Error('this command must not open a connection');
};

export const cliDeps = (out: Output, open: Opener, env: Env = {}): CliDeps => ({
  out,
  env,
  now: FIXED_NOW,
  open,
});
