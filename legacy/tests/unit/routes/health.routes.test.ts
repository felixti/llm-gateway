import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { Hono } from 'hono';
import { healthRoutes } from '@/routes/health.routes';
import { redis } from '@/db/redis';
import * as postgresClient from '@/db/client';
import * as healthService from '@/services/health.service';
import { resetHealthCacheForTests } from '@/services/health.service';
import { requestIdMiddleware } from '@/middleware/request-id';

interface HealthResponseBody {
  checks: {
    redis: boolean;
    postgres: boolean;
    deployments: boolean;
  };
}

describe('health.routes', () => {
  let originalBearer: string | undefined;

  function createApp(): Hono {
    const app = new Hono();
    app.use('*', requestIdMiddleware);
    app.route('/', healthRoutes);
    return app;
  }

  beforeEach(() => {
    resetHealthCacheForTests();
    originalBearer = process.env.METRICS_SCRAPE_BEARER;
  });

  afterEach(() => {
    if (originalBearer === undefined) {
      delete process.env.METRICS_SCRAPE_BEARER;
    } else {
      process.env.METRICS_SCRAPE_BEARER = originalBearer;
    }
    resetHealthCacheForTests();
  });

  describe('GET /ready', () => {
    it('returns 503 when Redis throws', async () => {
      const originalPing = redis.ping.bind(redis);
      redis.ping = async () => {
        throw new Error('Redis down');
      };

      const app = createApp();
      const res = await app.request('/ready');
      expect(res.status).toBe(503);
      const body = (await res.json()) as HealthResponseBody;
      expect(body.checks.redis).toBe(false);

      redis.ping = originalPing;
    });

    it('returns 503 when Postgres is unhealthy', async () => {
      const origPg = postgresClient.isPostgresHealthy;
      vi.spyOn(postgresClient, 'isPostgresHealthy').mockResolvedValue(false);

      const app = createApp();
      const res = await app.request('/ready');
      expect(res.status).toBe(503);
      const body = (await res.json()) as HealthResponseBody;
      expect(body.checks.postgres).toBe(false);

      vi.restoreAllMocks();
    });

    it('returns 503 when Postgres throws', async () => {
      vi.spyOn(postgresClient, 'isPostgresHealthy').mockRejectedValue(new Error('pg down'));

      const app = createApp();
      const res = await app.request('/ready');
      expect(res.status).toBe(503);
      const body = (await res.json()) as HealthResponseBody;
      expect(body.checks.postgres).toBe(false);

      vi.restoreAllMocks();
    });

    it('returns 503 when deployments are enabled but cache is empty', async () => {
      const origDeployments = process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = 'true';

      resetHealthCacheForTests();

      const app = createApp();
      const res = await app.request('/ready');
      const body = (await res.json()) as HealthResponseBody;

      expect(body.checks.deployments).toBe(false);

      if (origDeployments === undefined) {
        delete process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      } else {
        process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = origDeployments;
      }
    });

    it('skips deployment checks when HEALTH_CHECK_DEPLOYMENTS_ENABLED is false', async () => {
      const origDeployments = process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = 'false';

      const app = createApp();
      const res = await app.request('/ready');
      const body = (await res.json()) as HealthResponseBody;

      expect(body.checks.deployments).toBe(true);

      if (origDeployments === undefined) {
        delete process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      } else {
        process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = origDeployments;
      }
    });
  });

  describe('GET /metrics', () => {
    it('returns 401 when bearer is configured and no auth header provided', async () => {
      process.env.METRICS_SCRAPE_BEARER = 'my-secret-token';
      const app = createApp();

      const res = await app.request('/metrics');
      expect(res.status).toBe(401);
    });

    it('returns 401 when bearer token is wrong', async () => {
      process.env.METRICS_SCRAPE_BEARER = 'my-secret-token';
      const app = createApp();

      const res = await app.request('/metrics', {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('returns 200 when bearer token is correct', async () => {
      process.env.METRICS_SCRAPE_BEARER = 'my-secret-token';
      const app = createApp();

      const res = await app.request('/metrics', {
        headers: { Authorization: 'Bearer my-secret-token' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/plain');
    });

    it('returns 200 without auth when bearer is not configured', async () => {
      delete process.env.METRICS_SCRAPE_BEARER;
      const app = createApp();

      const res = await app.request('/metrics');
      expect(res.status).toBe(200);
    });

    it('returns 401 when Authorization header has wrong prefix', async () => {
      process.env.METRICS_SCRAPE_BEARER = 'my-secret-token';
      const app = createApp();

      const res = await app.request('/metrics', {
        headers: { Authorization: 'Basic my-secret-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /openapi.json', () => {
    it('returns the OpenAPI spec', async () => {
      const app = createApp();
      const res = await app.request('/openapi.json');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('openapi');
      expect(body).toHaveProperty('info');
    });
  });

  describe('GET /docs', () => {
    it('returns the docs page', async () => {
      const app = createApp();
      const res = await app.request('/docs');
      expect(res.status).toBe(200);
    });
  });
});
