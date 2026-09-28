import type { LimitsConfig } from './types.js';

export interface LimitsRuntime {
  readonly maxBodyBytes: number;
  readonly maxConcurrentPerIdentity: number;
  readonly maxConcurrent: number;
  readonly questionsPerMinute: number;
  readonly burst: number;
  readonly securityStrikes: number;
  readonly strikeWindowMs: number;
  readonly blockMs: number;
  readonly maxTrackedIdentities: number;
}

export const LIMIT_DEFAULTS: LimitsRuntime = {
  maxBodyBytes: 16_384,
  maxConcurrentPerIdentity: 2,
  maxConcurrent: 32,
  questionsPerMinute: 30,
  burst: 10,
  securityStrikes: 5,
  strikeWindowMs: 60_000,
  blockMs: 300_000,
  maxTrackedIdentities: 10_000,
};

const positive = (value: number | undefined, fallback: number, what: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${what} must be a positive number`);
  return value;
};

export function limitsRuntime(config: LimitsConfig = {}): LimitsRuntime {
  return {
    maxBodyBytes: positive(config.maxBodyBytes, LIMIT_DEFAULTS.maxBodyBytes, 'maxBodyBytes'),
    maxConcurrentPerIdentity: positive(
      config.maxConcurrentPerIdentity,
      LIMIT_DEFAULTS.maxConcurrentPerIdentity,
      'maxConcurrentPerIdentity',
    ),
    maxConcurrent: positive(config.maxConcurrent, LIMIT_DEFAULTS.maxConcurrent, 'maxConcurrent'),
    questionsPerMinute: positive(
      config.questionsPerMinute,
      LIMIT_DEFAULTS.questionsPerMinute,
      'questionsPerMinute',
    ),
    burst: positive(config.burst, LIMIT_DEFAULTS.burst, 'burst'),
    securityStrikes: positive(config.securityStrikes, LIMIT_DEFAULTS.securityStrikes, 'securityStrikes'),
    strikeWindowMs: positive(config.strikeWindowMs, LIMIT_DEFAULTS.strikeWindowMs, 'strikeWindowMs'),
    blockMs: positive(config.blockMs, LIMIT_DEFAULTS.blockMs, 'blockMs'),
    maxTrackedIdentities: positive(
      config.maxTrackedIdentities,
      LIMIT_DEFAULTS.maxTrackedIdentities,
      'maxTrackedIdentities',
    ),
  };
}

export type AdmitOutcome =
  | { readonly ok: true; readonly release: () => void }
  | {
      readonly ok: false;
      readonly status: 429 | 503;
      readonly detail: string;
      readonly retryAfterSec: number;
    };

interface Entry {
  tokens: number;
  refilledAt: number;
  inFlight: number;
  strikes: number[];
  blockedUntil: number;
  seenAt: number;
}

export interface Limiter {
  admit(identity: string, now: number): AdmitOutcome;
  /** Records an attack-shaped denial. True when this one started a cooldown. */
  strike(identity: string, now: number): boolean;
  active(): number;
  reset(): void;
}

const TOO_MANY = 'too many questions from this identity; try again shortly';
const TOO_BUSY = 'the server is answering as many questions as it can; try again shortly';

/**
 * In memory and per process. A multi-instance deployment gets N times these limits, which is
 * why the numbers are a floor on cost rather than a security control -- the security control
 * is the scope, not the budget.
 */
export function createLimiter(limits: LimitsRuntime): Limiter {
  const entries = new Map<string, Entry>();
  let inFlight = 0;

  const sweep = (now: number): void => {
    if (entries.size <= limits.maxTrackedIdentities) return;
    const idle: [string, Entry][] = [];
    for (const pair of entries) {
      const entry = pair[1];
      if (entry.inFlight === 0 && entry.blockedUntil <= now) idle.push(pair);
    }
    idle.sort((a, b) => a[1].seenAt - b[1].seenAt);
    const target = entries.size - limits.maxTrackedIdentities;
    for (let i = 0; i < idle.length && i < target; i += 1) entries.delete(idle[i]?.[0] ?? '');
  };

  const entryFor = (identity: string, now: number): Entry => {
    const found = entries.get(identity);
    if (found !== undefined) {
      found.seenAt = now;
      return found;
    }
    const fresh: Entry = {
      tokens: limits.burst,
      refilledAt: now,
      inFlight: 0,
      strikes: [],
      blockedUntil: 0,
      seenAt: now,
    };
    entries.set(identity, fresh);
    sweep(now);
    return fresh;
  };

  const refill = (entry: Entry, now: number): void => {
    const elapsed = Math.max(0, now - entry.refilledAt);
    entry.tokens = Math.min(limits.burst, entry.tokens + (elapsed * limits.questionsPerMinute) / 60_000);
    entry.refilledAt = now;
  };

  return {
    admit(identity, now) {
      const entry = entryFor(identity, now);
      if (entry.blockedUntil > now) {
        return {
          ok: false,
          status: 429,
          detail: TOO_MANY,
          retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000),
        };
      }
      if (inFlight >= limits.maxConcurrent) {
        return { ok: false, status: 503, detail: TOO_BUSY, retryAfterSec: 1 };
      }
      if (entry.inFlight >= limits.maxConcurrentPerIdentity) {
        return { ok: false, status: 429, detail: TOO_MANY, retryAfterSec: 1 };
      }
      refill(entry, now);
      if (entry.tokens < 1) {
        const waitMs = ((1 - entry.tokens) * 60_000) / limits.questionsPerMinute;
        return {
          ok: false,
          status: 429,
          detail: TOO_MANY,
          retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)),
        };
      }
      entry.tokens -= 1;
      entry.inFlight += 1;
      inFlight += 1;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          entry.inFlight = Math.max(0, entry.inFlight - 1);
          inFlight = Math.max(0, inFlight - 1);
        },
      };
    },

    strike(identity, now) {
      const entry = entryFor(identity, now);
      entry.strikes = entry.strikes.filter((at) => now - at < limits.strikeWindowMs);
      entry.strikes.push(now);
      if (entry.strikes.length < limits.securityStrikes) return false;
      entry.strikes = [];
      entry.blockedUntil = now + limits.blockMs;
      return true;
    },

    active: () => inFlight,

    reset() {
      entries.clear();
      inFlight = 0;
    },
  };
}
