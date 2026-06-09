/**
 * Test App Factory
 * Creates a Hono app with all routes for integration testing
 * Uses mock Redis and mock fetch so no external services are needed
 */

import { redis } from '@/db/redis';
import { requestIdMiddleware } from '@/middleware/request-id';
import { adminRoutes } from '@/routes/admin.routes';
import { chatRoutes } from '@/routes/chat.routes';
import { healthRoutes } from '@/routes/health.routes';
import { messagesRoutes } from '@/routes/messages.routes';
import { modelsRoutes } from '@/routes/models.routes';
import { quotaRoutes } from '@/routes/quota.routes';
import { responsesRoutes } from '@/routes/responses.routes';
import { Hono } from 'hono';
import { MockRedis } from './mock-redis';

let isRedisMocked = false;
let originalFetch: typeof fetch | undefined;

type RedisMockSurface = Pick<
  MockRedis,
  | 'get'
  | 'set'
  | 'setex'
  | 'eval'
  | 'hget'
  | 'hgetall'
  | 'hset'
  | 'pipeline'
  | 'incrbyfloat'
  | 'del'
  | 'ping'
  | 'scan'
  | 'ttl'
>;

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as RedisMockSurface;
  r.get = mock.get.bind(mock);
  r.set = mock.set.bind(mock);
  r.setex = mock.setex.bind(mock);
  r.eval = mock.eval.bind(mock);
  r.hget = mock.hget.bind(mock);
  r.hgetall = mock.hgetall.bind(mock);
  r.hset = mock.hset.bind(mock);
  r.pipeline = mock.pipeline.bind(mock);
  r.incrbyfloat = mock.incrbyfloat.bind(mock);
  r.del = mock.del.bind(mock);
  r.ping = mock.ping.bind(mock);
  r.scan = mock.scan.bind(mock);
  r.ttl = mock.ttl.bind(mock);
}

/** Bun/fetch may pass Headers or a plain header record — tests mirror outbound gateway calls. */
function readInitHeader(init: RequestInit | undefined, headerName: string): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  if (h instanceof Headers) {
    return h.get(headerName) ?? undefined;
  }
  if (Array.isArray(h)) {
    const lower = headerName.toLowerCase();
    for (const [k, v] of h) {
      if (k.toLowerCase() === lower && typeof v === 'string') {
        return v;
      }
    }
    return undefined;
  }
  const record = h as Record<string, string>;
  const entry = Object.entries(record).find(([k]) => k.toLowerCase() === headerName.toLowerCase());
  return entry?.[1];
}

function setupMockFetch(): void {
  if (originalFetch) return;
  originalFetch = globalThis.fetch;

  const mockFetch = async (
    input: Parameters<typeof fetch>[0],
    _init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    // Anthropic count_tokens (Azure AI Foundry shape)
    if (url.includes('/messages/count_tokens')) {
      const anthropicBeta = readInitHeader(_init, 'anthropic-beta');
      return new Response(
        JSON.stringify({
          input_tokens: 42,
          _test_echo_beta: anthropicBeta ?? null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Mock Azure OpenAI / AI Foundry / Anthropic responses
    if (url.includes('azure.com') || url.includes('ai.azure.com')) {
      return new Response(
        JSON.stringify({
          id: 'test-completion',
          object: 'chat.completion',
          created: Date.now(),
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Test response' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fallback: return 404 for unhandled URLs
    return new Response('Not Found', { status: 404 });
  };

  globalThis.fetch = Object.assign(mockFetch, {
    preconnect: originalFetch.preconnect,
  });
}

/**
 * Create a fully configured Hono app for integration tests
 * Monkey-patches Redis and global.fetch to avoid external service dependencies
 */
export async function createTestApp(): Promise<Hono> {
  // Setup mock Redis on first call
  if (!isRedisMocked) {
    bindMockRedis(new MockRedis());
    isRedisMocked = true;
  }

  // Create fresh mock instance for each test and rebind methods
  const mock = new MockRedis();
  bindMockRedis(mock);

  // Mock fetch for upstream Azure calls
  setupMockFetch();

  const app = new Hono();

  app.use('*', requestIdMiddleware);
  app.route('/v1/chat/completions', chatRoutes);
  app.route('/v1/messages', messagesRoutes);
  app.route('/v1/responses', responsesRoutes);
  app.route('/v1/models', modelsRoutes);
  app.route('/', healthRoutes);
  app.route('/quota', quotaRoutes);
  app.route('/admin', adminRoutes);

  return app;
}
