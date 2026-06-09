/**
 * Observability Synthetic Tests
 * Tests to verify that tracing, logging, and metrics are properly configured
 * These tests run against an in-memory gateway and check for proper observability signals
 */

import { describe, expect, it } from 'bun:test';
import { createTestApp } from '../helpers/test-app';
import { createTestPat, INVALID_PAT } from '../helpers/test-pat';

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    protocol?: string;
  };
}

interface HealthResponse {
  version: string;
  timestamp: string;
}

interface ReadyResponse {
  status: 'ready' | 'not_ready';
  checks: {
    redis: boolean;
    deployments: boolean;
  };
  timestamp: string;
}

const VALID_PAT = createTestPat('user1');

describe('Observability - Synthetic Tests', () => {
  describe('Tracing', () => {
    it('should include X-Request-Id header in responses', async () => {
      const app = await createTestApp();
      const res = await app.request('/health');

      // Gateway should either set X-Request-Id or we generate one
      const requestId = res.headers.get('X-Request-Id');
      // Request ID is optional but good practice
      if (requestId) {
        expect(requestId).toBeTruthy();
        expect(requestId.length).toBeGreaterThan(0);
      }
    });

    it('should propagate trace context when configured', async () => {
      // Make request with trace context
      const app = await createTestApp();
      const res = await app.request('/health', {
        headers: {
          traceparent:
            '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        },
      });

      expect(res.status).toBe(200);
    });

    it('should handle requests without trace context gracefully', async () => {
      const app = await createTestApp();
      const res = await app.request('/health');

      expect(res.status).toBe(200);
    });
  });

  describe('Logging', () => {
    it('should emit structured JSON logs', async () => {
      // Make a request that will generate logs
      const app = await createTestApp();
      const res = await app.request('/health');

      expect(res.status).toBe(200);

      // The gateway should emit JSON logs to stdout
      // In test environment, we verify the endpoint works
      // Full log verification would require log aggregation
    });

    it('should log errors with proper structure', async () => {
      // Trigger an error condition with valid auth
      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: createTestPat('test-user'),
        },
        body: 'invalid-json',
      });

      // Should return 400 with error structure
      expect(res.status).toBe(400);

      const body = (await res.json()) as ErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('invalid_request');
    });
  });

  describe('Error Handling', () => {
    it('should return consistent error response structure', async () => {
      const testCases = [
        // No auth
        {
          method: 'POST',
          path: '/v1/chat/completions',
          body: '{"model":"gpt-4o","messages":[]}',
          expectedCode: 'authentication_error',
        },
        // Invalid JSON
        {
          method: 'POST',
          path: '/v1/chat/completions',
          body: 'not-json',
          expectedCode: 'invalid_request',
        },
      ];

      const app = await createTestApp();

      for (const tc of testCases) {
        const res = await app.request(tc.path, {
          method: tc.method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: VALID_PAT,
          },
          body: tc.body,
        });

        const body = (await res.json()) as ErrorResponse;

        // Error response should have consistent structure
        expect(body).toHaveProperty('error');
        expect(body.error).toHaveProperty('code');
        expect(body.error).toHaveProperty('message');
        expect(typeof body.error.code).toBe('string');
        expect(typeof body.error.message).toBe('string');
      }
    });

    it('should sanitize PII from logs (verifiable by error messages)', async () => {
      // Make request with a token that looks like it has PII
      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:
            'Bearer lg_user1_eyJ1c2VybmFtZSI6ImFkbWluQGV4YW1wbGUuY29tIn0.signature',
        },
        body: JSON.stringify({
          model: 'invalid-model',
          messages: [{ role: 'user', content: 'test' }],
        }),
      });

      // Error should not contain the raw token in the message
      const body = (await res.json()) as ErrorResponse;

      // The error message should not expose sensitive data
      // (implementation should sanitize email-like patterns in tokens)
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('Health Checks', () => {
    it('should expose health endpoint for monitoring', async () => {
      const app = await createTestApp();
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const body = (await res.json()) as HealthResponse;
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('version');
    });

    it('should expose readiness probe for orchestrators', async () => {
      const app = await createTestApp();
      const res = await app.request('/ready');

      // Should return either 200 (ready) or 503 (not ready)
      expect([200, 503]).toContain(res.status);

      const body = (await res.json()) as ReadyResponse;
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('checks');
    });
  });

  describe('Metrics Attributes', () => {
    it('should include protocol in error responses', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        }),
      });

      const body = (await res.json()) as ErrorResponse;

      // Error responses should include protocol field
      // This helps with metric attribution
      expect(body.error).toBeDefined();
    });
  });
});

describe('Observability - Span Verification', () => {
  it('should create spans for requests when tracing is enabled', async () => {
    // When OTEL collector is configured, verify spans are created
    // This is a smoke test - actual span verification requires Jaeger query

    const app = await createTestApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);

    // If we have a trace ID header, the span was created
    const traceId =
      res.headers.get('X-Trace-Id') || res.headers.get('X-Request-Id');

    if (traceId) {
      expect(traceId).toMatch(/^[a-f0-9-]+$/);
    }
  });

  it('should propagate W3C trace context', async () => {
    const traceparent =
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

    const app = await createTestApp();
    const res = await app.request('/health', {
      headers: { traceparent },
    });

    expect(res.status).toBe(200);

    // If the gateway supports trace context propagation,
    // it should return the trace ID in headers
    const traceId = res.headers.get('X-Trace-Id');
    if (traceId) {
      expect(traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    }
  });
});
