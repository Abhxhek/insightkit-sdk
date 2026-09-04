import { BEGIN_READ_ONLY, ROLLBACK, sessionPreamble } from './execute.js';
import type { ConnectionSource, QueryOutcome, ReadOptions } from './types.js';

export type Ask = (sql: string) => Promise<QueryOutcome>;

/**
 * Runs SQL we wrote ourselves inside a transaction that opens read only and always
 * rolls back. Anything derived from a prompt goes through runGuardedRead instead,
 * which additionally refuses to run a query that was never approved.
 */
export async function inReadOnlyTransaction<T>(
  source: ConnectionSource,
  body: (ask: Ask) => Promise<T>,
  options: ReadOptions = {},
): Promise<T> {
  const preamble = sessionPreamble(options);
  const client = await source.connect();
  let rolledBack = false;
  try {
    await client.query(BEGIN_READ_ONLY);
    for (const statement of preamble) await client.query(statement);
    return await body((sql) => client.query(sql));
  } finally {
    try {
      await client.query(ROLLBACK);
      rolledBack = true;
    } catch {
      rolledBack = false;
    }
    client.release(!rolledBack);
  }
}
