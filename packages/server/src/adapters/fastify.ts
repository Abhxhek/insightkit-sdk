import type { NodeAdapterOptions, NodeRequestLike, NodeResponseLike, WebHandler } from './node.js';
import { toNodeHandler } from './node.js';

export interface FastifyRequestLike {
  readonly raw: NodeRequestLike;
}

export interface FastifyReplyLike {
  readonly raw: NodeResponseLike;
  hijack(): unknown;
}

/**
 * `hijack()` hands the socket over before fastify's own serialiser runs. Without it fastify
 * waits for the handler to resolve and a stream would only be delivered once it had ended.
 * Register the route with a body parser that leaves the raw stream alone, or before one.
 */
export function toFastifyHandler(
  handler: WebHandler,
  options: NodeAdapterOptions = {},
): (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void> {
  const node = toNodeHandler(handler, options);
  return async (request, reply) => {
    reply.hijack();
    await node(request.raw, reply.raw);
  };
}
