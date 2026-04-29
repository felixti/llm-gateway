/**
 * Health Routes
 * GET /health - version + timestamp
 * GET /ready - critical dependencies check (Redis + Azure connectivity)
 */

import { isRedisHealthy } from '@/db/redis';
import { getPrometheusMetrics } from '@/observability/metrics';
import { getAllDeploymentHealth } from '@/services/health.service';
import { Hono } from 'hono';

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
 * Checks critical dependencies: Redis and at least one Azure deployment
 * Returns 503 if critical dependencies are unavailable
 */
healthRoutes.get('/ready', async (c) => {
  const checks: Record<string, boolean> = {
    redis: false,
    deployments: false,
  };

  // Check Redis connectivity
  try {
    checks.redis = await isRedisHealthy();
  } catch {
    checks.redis = false;
  }

  // Check Azure deployments (at least one must be healthy)
  try {
    const allHealth = await getAllDeploymentHealth();
    const healthyDeployments = Array.from(allHealth.values()).filter((h) => h.healthy);
    checks.deployments = healthyDeployments.length > 0;
  } catch {
    checks.deployments = false;
  }

  const isReady = checks.redis && checks.deployments;

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

healthRoutes.get('/metrics', (c) => {
  return c.text(getPrometheusMetrics(), 200, {
    'Content-Type': 'text/plain; charset=utf-8',
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
