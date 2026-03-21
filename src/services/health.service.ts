/**
 * Health Service
 * Periodic deployment health checks with circuit breaker integration
 */

import {
  type DeploymentConfig,
  getAllDeployments,
  getDeploymentByAlias,
} from '../config/deployments';
import { getAzureAuthManager } from './azure-auth';
import { recordFailure } from './circuit-breaker';

// Health check interval in milliseconds
const HEALTH_CHECK_INTERVAL_MS = 30_000;

// Lightweight health check timeout
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

// Deployment health state
export interface DeploymentHealth {
  deploymentName: string;
  healthy: boolean;
  latencyMs: number;
  lastCheck: Date | null;
  error?: string;
}

/**
 * Perform a lightweight health check for chat-completions (OpenAI-compatible) deployment
 */
async function checkChatCompletionsHealth(
  deployment: DeploymentConfig
): Promise<{ latencyMs: number }> {
  const authManager = getAzureAuthManager();
  const headers = await authManager.getAuthHeadersForDeployment(deployment);

  const url = new URL(deployment.endpoint);
  url.pathname = `/openai/deployments/${deployment.azureModelName}/chat/completions`;
  url.searchParams.set('api-version', deployment.apiVersion);

  const startTime = Date.now();

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: deployment.azureModelName,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
  });

  const latencyMs = Date.now() - startTime;

  // 400 Bad Request is acceptable - means deployment is reachable
  // 401/403 would indicate auth issues which we still consider "reachable"
  if (response.status >= 500) {
    throw new Error(`Server error: ${response.status}`);
  }

  return { latencyMs };
}

/**
 * Perform a lightweight health check for anthropic-messages deployment
 */
async function checkAnthropicMessagesHealth(
  deployment: DeploymentConfig
): Promise<{ latencyMs: number }> {
  const authManager = getAzureAuthManager();
  const headers = await authManager.getAuthHeadersForDeployment(deployment);

  const url = new URL(deployment.endpoint);
  url.pathname = `/openai/deployments/${deployment.azureModelName}/messages`;
  url.searchParams.set('api-version', deployment.apiVersion);

  const startTime = Date.now();

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: deployment.azureModelName,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
  });

  const latencyMs = Date.now() - startTime;

  // 400 Bad Request is acceptable - means deployment is reachable
  if (response.status >= 500) {
    throw new Error(`Server error: ${response.status}`);
  }

  return { latencyMs };
}

/**
 * Check health of a single deployment
 */
export async function checkDeploymentHealth(
  deployment: DeploymentConfig
): Promise<DeploymentHealth> {
  const startTime = Date.now();

  try {
    let latencyMs: number;

    if (deployment.protocolFamily === 'anthropic-messages') {
      const result = await checkAnthropicMessagesHealth(deployment);
      latencyMs = result.latencyMs;
    } else {
      const result = await checkChatCompletionsHealth(deployment);
      latencyMs = result.latencyMs;
    }

    return {
      deploymentName: deployment.name,
      healthy: true,
      latencyMs,
      lastCheck: new Date(),
    };
  } catch (error) {
    // Mark unhealthy in circuit breaker
    recordFailure(deployment.name);

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
  const deployment = getDeploymentByAlias(deploymentName);
  if (!deployment) {
    return null;
  }
  return checkDeploymentHealth(deployment);
}

/**
 * Get health status for all enabled deployments
 */
export async function getAllDeploymentHealth(): Promise<Map<string, DeploymentHealth>> {
  const deployments = getAllDeployments();
  const healthMap = new Map<string, DeploymentHealth>();

  // Check all deployments in parallel
  const results = await Promise.all(
    deployments.map(async (deployment) => {
      const health = await checkDeploymentHealth(deployment);
      return { name: deployment.name, health };
    })
  );

  // Populate map
  for (const { name, health } of results) {
    healthMap.set(name, health);
  }

  return healthMap;
}

// Active health check interval handle
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic health checks for all deployments
 */
export function startHealthChecks(): void {
  if (healthCheckInterval !== null) {
    return; // Already running
  }

  healthCheckInterval = setInterval(async () => {
    await getAllDeploymentHealth();
  }, HEALTH_CHECK_INTERVAL_MS);

  // Don't keep process alive just for health checks
  if (healthCheckInterval.unref) {
    healthCheckInterval.unref();
  }
}

/**
 * Stop periodic health checks
 */
export function stopHealthChecks(): void {
  if (healthCheckInterval !== null) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}
