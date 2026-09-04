import { BEGIN_READ_ONLY, ROLLBACK } from '../execute.js';
import type { Check, CheckReport, ConnectionSource, IsolationProof } from '../types.js';

export async function proveIsolation(
  source: ConnectionSource,
  checks: readonly Check[],
): Promise<IsolationProof> {
  const client = await source.connect();
  const reports: CheckReport[] = [];
  let rolledBack = false;

  try {
    await client.query(BEGIN_READ_ONLY);
    for (const check of checks) {
      const base = { id: check.id, title: check.title, blocking: check.blocking };
      try {
        const outcome = await client.query(check.sql);
        const verdict = check.evaluate(outcome.rows);
        reports.push({ ...base, status: verdict.status, detail: verdict.detail });
      } catch (err) {
        // A check that cannot run has proven nothing, so it counts against the proof.
        reports.push({
          ...base,
          status: 'fail',
          detail: `check could not run: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } finally {
    try {
      await client.query(ROLLBACK);
      rolledBack = true;
    } catch {
      rolledBack = false;
    }
    client.release(!rolledBack);
  }

  const blockers = reports
    .filter((r) => r.blocking && r.status !== 'pass')
    .map((r) => `${r.id}: ${r.detail}`);
  const needsReview = reports
    .filter((r) => !r.blocking && r.status === 'review')
    .map((r) => `${r.id}: ${r.detail}`);

  return { proven: blockers.length === 0, checks: reports, blockers, needsReview };
}
