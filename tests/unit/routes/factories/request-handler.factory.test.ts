/**
 * Request Handler Factory Tests
 */

import { describe, expect, it, vi, beforeEach, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { createRequestHandler } from '@/routes/factories/request-handler.factory';
import { createRequestHandlerDeps, mockDeployment, testSchema } from './test-helpers';

// Access mocked modules
const mockGetDeploymentByAlias = vi.fn();
const mockIsRequestAllowed = vi.fn();
const mockGetAuthHeaders = vi.fn();
const mockProxyStreaming = vi.fn();
const mockProxyNonStreaming = vi.fn();

// Set up mocks BEFORE importing the factory
vi.mock('@/config/deployments', () => ({
  getDeploymentByAlias: (...args: unknown[]) => mockGetDeploymentByAlias(...args),
}));

vi.mock('@/services/azure-auth', () => ({
  getAzureAuthManager: () => ({
    getAuthHeaders: (...args: unknown[]) => mockGetAuthHeaders(...args),
    getAuthHeadersForDeployment: () => mockGetAuthHeaders(),
  }),
}));

vi.mock('@/services/circuit-breaker', () => ({
  isRequestAllowed: (...args: unknown[]) => mockIsRequestAllowed(...args),
}));

const debugEntries: unknown[] = [];

vi.mock('@/observability/logger', () => ({
  logDebugRequestMetadata: (...args: unknown[]) => debugEntries.push(args),
}));

describe('Request Handler Factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    debugEntries.length = 0;
    // Default mock behaviors
    mockGetAuthHeaders.mockResolvedValue({ Authorization: 'Bearer test' });
    mockProxyStreaming.mockResolvedValue(new Response());
    mockProxyNonStreaming.mockResolvedValue(new Response());
  });

  describe('createRequestHandler', () => {
    it('should create handler with correct dependencies', () => {
      const deps = createRequestHandlerDeps();
      const handler = createRequestHandler(deps);
      expect(typeof handler).toBe('function');
    });

    it('should return 400 for invalid JSON body', async () => {
      const app = new Hono();
      const deps = createRequestHandlerDeps();
      const handler = createRequestHandler(deps);
      app.post('/', handler);

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-valid-json',
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('should return 400 for body that fails Zod validation', async () => {
      const app = new Hono();
      const deps = createRequestHandlerDeps();
      const handler = createRequestHandler(deps);
      app.post('/', handler);

      // Missing required 'model' and 'messages' fields
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: 'body' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('should return 400 for unknown model', async () => {
      mockGetDeploymentByAlias.mockReturnValue(undefined);
      mockIsRequestAllowed.mockReturnValue(true);

      const app = new Hono();
      const deps = createRequestHandlerDeps();
      const handler = createRequestHandler(deps);
      app.post('/', handler);

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'unknown-model', messages: [] }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('model_not_supported');
    });

    it('should return 503 when circuit breaker is open', async () => {
      mockGetDeploymentByAlias.mockReturnValue(mockDeployment);
      mockIsRequestAllowed.mockReturnValue(false);

      const app = new Hono();
      const deps = createRequestHandlerDeps();
      const handler = createRequestHandler(deps);
      app.post('/', handler);

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [] }),
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('service_unavailable');
    });

    it('should route to non-streaming proxy when stream is false', async () => {
      mockGetDeploymentByAlias.mockReturnValue(mockDeployment);
      mockIsRequestAllowed.mockReturnValue(true);

      const app = new Hono();
      const deps = createRequestHandlerDeps();
      deps.proxyNonStreaming = mockProxyNonStreaming;
      deps.proxyStreaming = mockProxyStreaming;
      const handler = createRequestHandler(deps);
      app.post('/', handler);

      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [], stream: false }),
      });

      expect(mockProxyNonStreaming).toHaveBeenCalled();
      expect(mockProxyStreaming).not.toHaveBeenCalled();
    });

    it('passes authenticated request metadata to proxy functions', async () => {
      mockGetDeploymentByAlias.mockReturnValue(mockDeployment);
      mockIsRequestAllowed.mockReturnValue(true);

      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('userId', 'user-123');
        c.set('requestId', 'req-123');
        c.set('reservationId', 'res-123');
        await next();
      });
      const deps = createRequestHandlerDeps();
      deps.proxyNonStreaming = mockProxyNonStreaming;
      const handler = createRequestHandler(deps);
      app.post('/', handler);

      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [], stream: false }),
      });

      expect(mockProxyNonStreaming.mock.calls[0][4]).toMatchObject({
        userId: 'user-123',
        requestId: 'req-123',
        reservationId: 'res-123',
      });
    });

    it('debug logging records request metadata without message content', async () => {
      mockGetDeploymentByAlias.mockReturnValue(mockDeployment);
      mockIsRequestAllowed.mockReturnValue(true);

      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('userId', 'user-123');
        await next();
      });
      const deps = createRequestHandlerDeps();
      deps.proxyNonStreaming = mockProxyNonStreaming;
      const handler = createRequestHandler(deps);
      app.post('/', handler);

      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: 'secret prompt content' }],
          stream: false,
        }),
      });

      const serialized = JSON.stringify(debugEntries);
      expect(serialized).toContain('messageCount');
      expect(serialized).not.toContain('secret prompt content');
      expect(serialized).not.toContain('"messages"');
      expect(serialized).not.toContain('"content"');
    });

    it('should route to streaming proxy when stream is true', async () => {
      mockGetDeploymentByAlias.mockReturnValue(mockDeployment);
      mockIsRequestAllowed.mockReturnValue(true);

      const app = new Hono();
      const deps = createRequestHandlerDeps();
      deps.proxyNonStreaming = mockProxyNonStreaming;
      deps.proxyStreaming = mockProxyStreaming;
      const handler = createRequestHandler(deps);
      app.post('/', handler);

      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [], stream: true }),
      });

      expect(mockProxyStreaming).toHaveBeenCalled();
      expect(mockProxyNonStreaming).not.toHaveBeenCalled();
    });
  });
});
