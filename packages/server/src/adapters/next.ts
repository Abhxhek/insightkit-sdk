import type { WebHandler } from './node.js';

/**
 * A Next.js route handler already takes a `Request` and returns a `Response`, so this exists
 * to name the seam rather than to convert anything. Mount it in
 * `app/api/insightkit/[...route]/route.ts` and export it as POST and GET.
 */
export const toNextRouteHandler =
  (handler: WebHandler) =>
  (request: Request): Promise<Response> =>
    handler(request);

export interface NextRouteHandlers {
  readonly POST: (request: Request) => Promise<Response>;
  readonly GET: (request: Request) => Promise<Response>;
}

export const toNextRoute = (handler: WebHandler): NextRouteHandlers => ({
  POST: (request) => handler(request),
  GET: (request) => handler(request),
});
