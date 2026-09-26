import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

/** Plucks the version without validating the rest, so a mismatch reports as itself rather than as a parse failure. */
export const protocolVersionOf = (value: unknown): number | null => {
  if (typeof value !== 'object' || value === null) return null;
  const version = (value as { readonly protocol?: unknown }).protocol;
  return typeof version === 'number' && Number.isInteger(version) ? version : null;
};
