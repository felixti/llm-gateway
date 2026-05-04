/**
 * Health Service
 * Periodic deployment health checks with circuit breaker integration.
 *
 * Uses non-billing Azure endpoints (GET deployment metadata / models listing)
 * instead of live LLM calls to avoid token costs from health probes.
 */

import {
  type DeploymentConfig,
  FOUNDRY_FAMILIES,
  getAllDeployments,
  getDeploymentByAlias,
} from '@/config/deployments';
import { env } from '@/config/env';
import { logger } from '@/observability/logger';
import { upstreamHttpsFetch } from '@/utils/fetch';
import { getAzureAuthManager } from './azure-auth';
import { recordFailure } from './circuit-breaker';

// Deployment health state
export interface DeploymentHealth {
  deploymentName: string;
  healthy: boolean;
  latencyMs: number;
  lastCheck: Date | null;
  error?: string;
}

/**
 * Build the non-billing health-check URL for a deployment.
 *
 * - Azure OpenAI (GPT): GET /openai/deployments/{name}?api-version=...
 *   Returns deployment metadata (model, status, SKU) without generating tokens.
 *
 * - Azure AI Foundry (Kimi/GLM/MiniMax/Claude): GET /models?api-version=...
 *   Returns the list of available models — proves endpoint connectivity and
 *   auth without any token billing.
 */
function buildHealthCheckUrl(deployment: DeploymentConfig): string {
  const url = new URL(deployment.endpoint);

  if (FOUNDRY_FAMILIES.includes(deployment.modelFamily)) {
    url.pathname = '/models';
  } else if (deployment.protocolFamily === 'anthropic-messages') {
    url.pathname = '/models';
  } else {
    url.pathname = `/openai/deployments/${deployment.name}`;
  }

  url.searchParams.set('api-version', deployment.apiVersion);
  return url.toString();
}

/**
 * Perform a lightweight (non-billing) health check via GET deployment metadata
 * for Azure OpenAI, or GET models listing for Azure AI Foundry deployments.
 */
async function checkDeploymentConnectivity(
  deployment: DeploymentConfig
): Promise<{ latencyMs: number }> {
  const authManager = getAzureAuthManager();
  const headers = await authManager.getAuthHeadersForDeployment(deployment);

  const url = buildHealthCheckUrl(deployment);
  const startTime = Date.now();

  const response = await upstreamHttpsFetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(env.HEALTH_CHECK_TIMEOUT_MS),
  });

  const latencyMs = Date.now() - startTime;

  if (!response.ok) {
    throw new Error(`Upstream returned error: ${response.status}`);
  }

  return { latencyMs };
}

/**
 * Check health of a single deployment
 * @internal
 */
export async function checkDeploymentHealth(
  deployment: DeploymentConfig
): Promise<DeploymentHealth> {
  const startTime = Date.now();

  try {
    const result = await checkDeploymentConnectivity(deployment);

    return {
      deploymentName: deployment.name,
      healthy: true,
      latencyMs: result.latencyMs,
      lastCheck: new Date(),
    };
  } catch (error) {
    // Mark unhealthy in circuit breaker
    try {
      await recordFailure(deployment.name);
    } catch (recordError) {
      logger.warn(
        { err: recordError, deployment: deployment.name },
        'Failed to record deployment health failure in circuit breaker'
      );
    }

    return {
      deploymentName: deployment.name,
      healthy: false,
      latencyMs: Date.now() - startTime,
      lastCheck: new Date(),
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get health status for a specific deployment by name
 */
export async function getDeploymentHealth(
  deploymentName: string
): Promise<DeploymentHealth | null> {
  if (!env.HEALTH_CHECK_DEPLOYMENTS_ENABLED) {
    const deployment = getDeploymentByAlias(deploymentName);
    return deployment
      ? { deploymentName: deployment.name, healthy: false, latencyMs: 0, lastCheck: null }
      : null;
  }
  const deployment = getDeploymentByAlias(deploymentName);
  if (!deployment) {
    return null;
  }
  return checkDeploymentHealth(deployment);
}

// In-memory snapshot of the most recent probe for every deployment.
// /ready reads this map so k8s probes never trigger live LLM calls.
const healthCache = new Map<string, DeploymentHealth>();

/**
 * Get health status for all enabled deployments.
 * Performs LIVE probes in parallel. Callers on the hot path should prefer
 * {@link getCachedDeploymentHealth} to avoid billable upstream calls.
 */
export async function getAllDeploymentHealth(): Promise<Map<string, DeploymentHealth>> {
  if (!env.HEALTH_CHECK_DEPLOYMENTS_ENABLED) {
    return healthCache;
  }

  const deployments = getAllDeployments();
  const healthMap = new Map<string, DeploymentHealth>();

  const results = await Promise.all(
    deployments.map(async (deployment) => {
      const health = await checkDeploymentHealth(deployment);
      return { name: deployment.name, health };
    })
  );

  for (const { name, health } of results) {
    healthMap.set(name, health);
    healthCache.set(name, health);
  }

  return healthMap;
}

/**
 * Return the most recent cached health snapshot (populated by the scheduled
 * probe). Returns an empty map until the first probe has completed.
 */
export function getCachedDeploymentHealth(): ReadonlyMap<string, DeploymentHealth> {
  return healthCache;
}

/**
 * Reset the in-memory health cache (testing only).
 * @internal
 */
export function resetHealthCacheForTests(): void {
  healthCache.clear();
}

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic health checks for all deployments.
 * Kicks off an immediate probe so `/ready` has data before the first interval.
 */
export function startHealthChecks(): void {
  if (
    healthCheckInterval !== null ||
    !env.HEALTH_CHECK_ENABLED ||
    !env.HEALTH_CHECK_DEPLOYMENTS_ENABLED
  ) {
    return;
  }

  // Prime the cache on startup (fire-and-forget; errors are already logged inside).
  void getAllDeploymentHealth();

  healthCheckInterval = setInterval(() => {
    void getAllDeploymentHealth();
  }, env.HEALTH_CHECK_INTERVAL_MS);

  if (healthCheckInterval.unref) {
    healthCheckInterval.unref();
  }
}

export function stopHealthChecks(): void {
  if (healthCheckInterval !== null) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}
