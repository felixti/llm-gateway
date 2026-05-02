/**
 * Health Routes
 * GET /health - version + timestamp
 * GET /ready - critical dependencies check (Redis + Azure connectivity)
 */

import { timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env';
import { isPostgresHealthy } from '@/db/client';
import { isRedisHealthy } from '@/db/redis';
import { getPrometheusMetrics } from '@/observability/metrics';
import { getCachedDeploymentHealth } from '@/services/health.service';
import { Scalar } from '@scalar/hono-api-reference';
import { Hono } from 'hono';

const BEARER_PREFIX = 'Bearer ';

function metricsBearerAuthorized(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return false;
  }
  const token = authHeader.slice(BEARER_PREFIX.length);
  try {
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Lazy-load OpenAPI spec to avoid bundling it into hot paths
let openApiSpec: Record<string, unknown> | null = null;
async function getOpenApiSpec(): Promise<Record<string, unknown>> {
  if (!openApiSpec) {
    const spec = await import('../../openapi.json', { with: { type: 'json' } });
    openApiSpec = spec.default;
  }
  return openApiSpec;
}

export const healthRoutes = new Hono();

// Package version from environment or fallback
const APP_VERSION = process.env.APP_VERSION || '1.0.0';

/**
 * GET /health
 * Returns version and timestamp - always returns 200 if server is running
 */
healthRoutes.get('/health', (c) => {
  return c.json({
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /ready
 * Checks critical dependencies: Redis, Postgres, and at least one Azure deployment.
 *
 * Deployment health is read from the in-memory cache populated by
 * `startHealthChecks()` so probes (Kubernetes liveness/readiness at 1-10s
 * intervals) do not trigger real upstream LLM calls. If the cache is empty
 * (e.g. server just started), deployments are reported as unknown and the
 * endpoint returns 503 until the first background probe completes.
 */
healthRoutes.get('/ready', async (c) => {
  const checks: Record<string, boolean> = {
    redis: false,
    postgres: false,
    deployments: false,
  };

  try {
    checks.redis = await isRedisHealthy();
  } catch {
    checks.redis = false;
  }

  try {
    checks.postgres = await isPostgresHealthy();
  } catch {
    checks.postgres = false;
  }

  if (env.HEALTH_CHECK_DEPLOYMENTS_ENABLED) {
    const cachedHealth = getCachedDeploymentHealth();
    checks.deployments = Array.from(cachedHealth.values()).some((h) => h.healthy);
  } else {
    checks.deployments = true;
  }

  const isReady = checks.redis && checks.postgres && checks.deployments;

  if (!isReady) {
    return c.json(
      {
        status: 'not_ready',
        checks,
        timestamp: new Date().toISOString(),
      },
      503
    );
  }

  return c.json({
    status: 'ready',
    checks,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /openapi.json
 * Returns the OpenAPI 3.1 specification
 */
healthRoutes.get('/openapi.json', async (c) => {
  const spec = await getOpenApiSpec();
  return c.json(spec);
});

/**
 * GET /metrics
 * Prometheus-compatible metrics endpoint
 */
healthRoutes.get('/metrics', (c) => {
  const bearer = env.METRICS_SCRAPE_BEARER;
  if (bearer && !metricsBearerAuthorized(c.req.header('Authorization'), bearer)) {
    return c.text('Unauthorized', 401);
  }
  const metrics = getPrometheusMetrics();
  return c.text(metrics, 200, {
    'Content-Type': 'text/plain; version=0.0.4',
  });
});

/**
 * GET /docs
 * Interactive API documentation powered by Scalar
 */
healthRoutes.get(
  '/docs',
  Scalar({
    url: '/openapi.json',
    pageTitle: 'LLM Gateway API Reference',
    theme: 'purple',
  })
);
