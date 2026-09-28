import type { WebHandler } from './node.js';

/** Hono already carries the web `Request`; `c.req.raw` is it. Structural, so hono is not a dependency. */
export interface HonoContextLike {
  readonly req: { readonly raw: Request };
}

export const toHonoHandler =
  (handler: WebHandler) =>
  (context: HonoContextLike): Promise<Response> =>
    handler(context.req.raw);
