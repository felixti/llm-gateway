/**
 * Health Routes Integration Tests
 * Tests for GET /health and GET /ready endpoints
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { createTestApp } from '../helpers/test-app';
import { redis } from '../../../src/db/redis';

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

describe('Health Routes', () => {
  describe('GET /health', () => {
    it('should return 200 with version and timestamp', async () => {
      const app = await createTestApp();
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const body = (await res.json()) as HealthResponse;
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('timestamp');
      expect(typeof body.version).toBe('string');
      expect(typeof body.timestamp).toBe('string');
    });

    it('should return valid ISO timestamp', async () => {
      const app = await createTestApp();
      const res = await app.request('/health');
      const body = (await res.json()) as HealthResponse;

      const timestamp = new Date(body.timestamp);
      expect(timestamp.getTime()).not.toBeNaN();
    });
  });

  describe('GET /ready', () => {
    it('should return 200 or 503 depending on dependencies', async () => {
      const app = await createTestApp();
      const res = await app.request('/ready');
      const body = (await res.json()) as ReadyResponse;

      // Status should be either 200 (ready) or 503 (not ready)
      expect([200, 503]).toContain(res.status);
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('checks');
      expect(body).toHaveProperty('timestamp');
    });

    it('should include redis and deployments checks', async () => {
      const app = await createTestApp();
      const res = await app.request('/ready');
      const body = (await res.json()) as ReadyResponse;

      expect(body.checks).toHaveProperty('redis');
      expect(body.checks).toHaveProperty('deployments');
      expect(typeof body.checks.redis).toBe('boolean');
      expect(typeof body.checks.deployments).toBe('boolean');
    });

    it('should return ready status when all checks pass', async () => {
      const app = await createTestApp();
      const res = await app.request('/ready');
      const body = (await res.json()) as ReadyResponse;

      if (res.status === 200) {
        expect(body.status).toBe('ready');
        expect(body.checks.redis).toBe(true);
        expect(body.checks.deployments).toBe(true);
      }
    });

    it('should return not_ready status when a check fails', async () => {
      const app = await createTestApp();
      const res = await app.request('/ready');
      const body = (await res.json()) as ReadyResponse;

      if (res.status === 503) {
        expect(body.status).toBe('not_ready');
      }
    });

    it('should return 503 when Redis is unhealthy', async () => {
      const app = await createTestApp();

      const originalPing = redis.ping.bind(redis);
      redis.ping = async () => { throw new Error('Redis down'); };

      const res = await app.request('/ready');
      const body = (await res.json()) as ReadyResponse;

      expect(res.status).toBe(503);
      expect(body.status).toBe('not_ready');
      expect(body.checks.redis).toBe(false);

      redis.ping = originalPing;
    });
  });

  describe('GET /metrics', () => {
    it('should return Prometheus-formatted metrics', async () => {
      const app = await createTestApp();
      const res = await app.request('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/plain');
      const text = await res.text();
      expect(text).toContain('http_requests_total');
      expect(text).toContain('llm_tokens_total');
    });
  });
});
