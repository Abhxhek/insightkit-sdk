import { handleAsk } from './ask.js';
import { createRuntime } from './config.js';
import { askError } from './http.js';
import { createStreamRegistry, handleSubscribe } from './subscribe.js';
import type { InsightKitConfig, InsightKitServer } from './types.js';

const lastSegment = (url: string): string => {
  const path = new URL(url).pathname;
  const parts = path.split('/').filter((part) => part !== '');
  return parts[parts.length - 1] ?? '';
};

export function createInsightKit(config: InsightKitConfig): InsightKitServer {
  const rt = createRuntime(config);
  const registry = createStreamRegistry();

  const ask = (request: Request): Promise<Response> => handleAsk(rt, request);
  const subscribe = (request: Request): Promise<Response> => handleSubscribe(rt, request, registry);

  return {
    ask,
    subscribe,
    handler(request) {
      const segment = lastSegment(request.url);
      if (segment === rt.routes.ask) return ask(request);
      if (segment === rt.routes.subscribe) return subscribe(request);
      return Promise.resolve(askError(404, 'no such endpoint'));
    },
    async checkGlossary() {
      return rt.checkGlossary(await rt.schema());
    },
    async close() {
      registry.shutdown();
    },
  };
}
