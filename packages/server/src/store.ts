import type { StreamRecord, StreamStore } from './types.js';

const TOKEN_BYTES = 32;

export function newStreamToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export interface MemoryStoreOptions {
  readonly maxTotal: number;
  readonly maxPerIdentity: number;
}

/**
 * Tokens live in this process only. A host behind a load balancer needs a shared store, and
 * that store must keep the SQL and re-run `approve` on the way out rather than reviving a
 * branded object, so nothing can subscribe to a query the guard has not seen this boot.
 */
export function createMemoryStreamStore(options: MemoryStoreOptions): StreamStore {
  const records = new Map<string, StreamRecord>();

  const drop = (now: number): void => {
    for (const [token, record] of records) {
      if (record.expiresAt <= now) records.delete(token);
    }
  };

  return {
    issue(record) {
      drop(record.issuedAt);
      const mine = [...records.values()].filter((r) => r.identity === record.identity);
      if (mine.length >= options.maxPerIdentity) {
        const oldest = mine.sort((a, b) => a.issuedAt - b.issuedAt)[0];
        if (oldest !== undefined) records.delete(oldest.token);
      }
      while (records.size >= options.maxTotal) {
        const first = records.keys().next();
        if (first.done === true) break;
        records.delete(first.value);
      }
      records.set(record.token, record);
    },

    get(token, now) {
      const record = records.get(token);
      if (record === undefined) return undefined;
      if (record.expiresAt <= now) {
        records.delete(token);
        return undefined;
      }
      return record;
    },

    revoke(token) {
      records.delete(token);
    },

    countFor(identity, now) {
      drop(now);
      let count = 0;
      for (const record of records.values()) if (record.identity === identity) count += 1;
      return count;
    },

    sweep(now) {
      drop(now);
    },
  };
}
