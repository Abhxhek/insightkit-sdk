import { z } from 'zod';
import type { ParseResult } from './parse.js';
import { parseWith } from './parse.js';
import { resultSetSchema } from './result.js';
import { prose } from './text.js';
import { protocolVersionSchema } from './version.js';

export const MAX_STREAM_TOKEN_LENGTH = 512;

export const MIN_STREAM_INTERVAL_MS = 1_000;
export const MAX_STREAM_INTERVAL_MS = 3_600_000;

/**
 * Opaque and issued by the server. A client subscribes by handing back a token it was
 * given, never by naming a query: the same instinct as a guarded query's brand, so
 * nothing can ask for live rows it was not already granted.
 */
export const streamTokenSchema = z.string().min(1).max(MAX_STREAM_TOKEN_LENGTH);

export const subscribeRequestSchema = z.strictObject({
  token: streamTokenSchema,
  /** A hint. The server clamps it, or a client asking for 10ms would drive the load. */
  intervalMs: z.number().int().min(MIN_STREAM_INTERVAL_MS).max(MAX_STREAM_INTERVAL_MS).optional(),
});

/**
 * Whole frames, not deltas: a delta needs stable row identity, which a grouped
 * aggregate does not have. The chart is absent on purpose -- a subscription re-runs the
 * query that was already approved and never re-plans, so the shape cannot change under
 * the viewer and a timer cannot spend model tokens.
 */
export const streamSnapshotSchema = z.strictObject({
  type: z.literal('snapshot'),
  protocol: protocolVersionSchema,
  data: resultSetSchema,
  truncated: z.boolean(),
  /** ISO 8601, as text. A Date cannot survive the wire; see ADR 0007. */
  at: z.string().min(1).max(64),
});

export const streamErrorSchema = z.strictObject({
  type: z.literal('error'),
  protocol: protocolVersionSchema,
  message: prose(2000),
});

export const STREAM_CLOSE_REASONS = ['expired', 'replaced', 'shutdown', 'failed'] as const;

export const streamClosedSchema = z.strictObject({
  type: z.literal('closed'),
  protocol: protocolVersionSchema,
  reason: z.enum(STREAM_CLOSE_REASONS),
});

export const streamEventSchema = z.discriminatedUnion('type', [
  streamSnapshotSchema,
  streamErrorSchema,
  streamClosedSchema,
]);

export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;
export type StreamSnapshot = z.infer<typeof streamSnapshotSchema>;
export type StreamError = z.infer<typeof streamErrorSchema>;
export type StreamClosed = z.infer<typeof streamClosedSchema>;
export type StreamEvent = z.infer<typeof streamEventSchema>;
export type StreamCloseReason = (typeof STREAM_CLOSE_REASONS)[number];

export const parseSubscribeRequest = (value: unknown): ParseResult<SubscribeRequest> =>
  parseWith(subscribeRequestSchema, value);

export const parseStreamEvent = (value: unknown): ParseResult<StreamEvent> =>
  parseWith(streamEventSchema, value);
