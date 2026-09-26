import { z } from 'zod';
import { chartSpecSchema } from './chart.js';
import { type ParseResult, parseWith } from './parse.js';
import { resultSetSchema } from './result.js';
import { prose } from './text.js';
import { protocolVersionSchema } from './version.js';

/** An unbounded question is an unbounded prompt, so the cap is a cost control before it is anything else. */
export const MAX_QUESTION_LENGTH = 2000;

export const MAX_MESSAGE_LENGTH = 2000;

export const askRequestSchema = z.strictObject({
  question: prose(MAX_QUESTION_LENGTH),
});

export type AskRequest = z.infer<typeof askRequestSchema>;

export const askOkResponseSchema = z.strictObject({
  status: z.literal('ok'),
  protocol: protocolVersionSchema,
  chart: chartSpecSchema,
  data: resultSetSchema,
  truncated: z.boolean(),
  /** Present only when the host opts in. Customer-facing embeds leave it off. */
  sql: z.string().optional(),
});

export const askUnanswerableResponseSchema = z.strictObject({
  status: z.literal('unanswerable'),
  protocol: protocolVersionSchema,
  message: prose(MAX_MESSAGE_LENGTH),
});

export const askRefusedResponseSchema = z.strictObject({
  status: z.literal('refused'),
  protocol: protocolVersionSchema,
  message: prose(MAX_MESSAGE_LENGTH),
});

export const askErrorResponseSchema = z.strictObject({
  status: z.literal('error'),
  protocol: protocolVersionSchema,
  message: prose(MAX_MESSAGE_LENGTH),
});

export const askResponseSchema = z.discriminatedUnion('status', [
  askOkResponseSchema,
  askUnanswerableResponseSchema,
  askRefusedResponseSchema,
  askErrorResponseSchema,
]);

export type AskOkResponse = z.infer<typeof askOkResponseSchema>;
export type AskUnanswerableResponse = z.infer<typeof askUnanswerableResponseSchema>;
export type AskRefusedResponse = z.infer<typeof askRefusedResponseSchema>;
export type AskErrorResponse = z.infer<typeof askErrorResponseSchema>;
export type AskResponse = z.infer<typeof askResponseSchema>;
export type AskStatus = AskResponse['status'];

export const parseAskRequest = (value: unknown): ParseResult<AskRequest> =>
  parseWith(askRequestSchema, value);

export const parseAskResponse = (value: unknown): ParseResult<AskResponse> =>
  parseWith(askResponseSchema, value);
