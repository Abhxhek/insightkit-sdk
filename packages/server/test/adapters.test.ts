import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { toFastifyHandler } from '../src/adapters/fastify.js';
import { toHonoHandler } from '../src/adapters/hono.js';
import { toNextRoute } from '../src/adapters/next.js';
import type { NodeResponseLike } from '../src/adapters/node.js';
import { toNodeHandler } from '../src/adapters/node.js';
import { createInsightKit } from '../src/insightkit.js';
import { askRequest, draft, fakeDatabase, singleTenantConfig } from './fake.js';

const ik = createInsightKit(
  singleTenantConfig(
    { live: { minIntervalMs: 20, defaultIntervalMs: 20, maxDurationMs: 80, keepaliveMs: 1_000 } },
    { script: Array.from({ length: 10 }, () => draft()), database: fakeDatabase() },
  ),
);

// The callback signature is the assignability check: IncomingMessage and ServerResponse must
// satisfy the structural types, or this file does not compile.
const node = toNodeHandler(ik.handler);
const server = createServer((request, response) => void node(request, response));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/insightkit`;

afterAll(async () => {
  await ik.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the node adapter', () => {
  it('carries a question and an answer over a real socket', async () => {
    const response = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'how many users by signup method' }),
    });

    expect(response.status).toBe(200);
    const answer = (await response.json()) as Record<string, unknown>;
    expect(answer.status).toBe('ok');
    expect(answer.stream).toBeTypeOf('string');
  });

  it('delivers stream frames before the response ends', async () => {
    const first = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'how many users' }),
    });
    const token = ((await first.json()) as { stream?: string }).stream;
    expect(token).toBeTypeOf('string');

    const stream = await fetch(`${base}/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    const body = stream.body;
    if (body === null) throw new Error('no stream body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let sawSnapshotWhileOpen = false;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
      if (text.includes('"snapshot"')) sawSnapshotWhileOpen = true;
    }

    expect(sawSnapshotWhileOpen).toBe(true);
    expect(text).toContain('"reason":"expired"');
  });

  it('refuses a body over the adapter cap without reading the rest', async () => {
    const tiny = toNodeHandler(ik.handler, { maxBodyBytes: 8 });
    const captured: { status: number; chunks: string[] } = { status: 0, chunks: [] };
    const response: NodeResponseLike = {
      writeHead(status) {
        captured.status = status;
        return undefined;
      },
      write() {
        return true;
      },
      end(chunk) {
        if (chunk !== undefined) captured.chunks.push(new TextDecoder().decode(chunk));
        return undefined;
      },
      on() {
        return undefined;
      },
    };

    await tiny(
      {
        method: 'POST',
        url: '/ask',
        headers: { host: 'host.test', 'content-type': 'application/json' },
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode(JSON.stringify({ question: 'a much longer question' }));
        },
      },
      response,
    );

    expect(captured.status).toBe(413);
    expect(captured.chunks.join('')).toContain('too large');
  });
});

describe('the framework seams', () => {
  it('hands hono its own raw request', async () => {
    const handler = toHonoHandler(ik.handler);
    const response = await handler({ req: { raw: askRequest('how many users') } });
    expect(response.status).toBe(200);
  });

  it('exports next route handlers for POST and GET', async () => {
    const route = toNextRoute(ik.handler);
    expect(await route.POST(askRequest('how many users')).then((r) => r.status)).toBe(200);
    expect(await route.GET(new Request('http://host.test/ask')).then((r) => r.status)).toBe(405);
  });

  it('hijacks a fastify reply before writing', async () => {
    let hijacked = false;
    const chunks: string[] = [];
    const raw: NodeResponseLike = {
      writeHead() {
        return undefined;
      },
      write(chunk) {
        chunks.push(new TextDecoder().decode(chunk));
        return true;
      },
      end() {
        return undefined;
      },
      on() {
        return undefined;
      },
    };

    const handler = toFastifyHandler(ik.handler);
    await handler(
      {
        raw: {
          method: 'POST',
          url: '/ask',
          headers: { host: 'host.test', 'content-type': 'application/json' },
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode(JSON.stringify({ question: 'how many users' }));
          },
        },
      },
      {
        raw,
        hijack() {
          hijacked = true;
          return undefined;
        },
      },
    );

    expect(hijacked).toBe(true);
    expect(chunks.join('')).toContain('"status":"ok"');
  });
});
