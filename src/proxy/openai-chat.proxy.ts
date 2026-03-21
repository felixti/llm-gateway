/**
 * OpenAI Chat Completions Proxy
 * Proxies requests to Azure OpenAI (GPT) and Azure AI Foundry (Kimi/GLM/MiniMax)
 * Handles streaming with usage extraction and quota reconciliation
 */

import { Hono } from 'hono';
import type { DeploymentConfig } from '../config/deployments';
import { getDeploymentByAlias } from '../config/deployments';
import { AzureAuthManager } from '../services/azure-auth';
import { isRequestAllowed, recordFailure, recordSuccess } from '../services/circuit-breaker';
import type { TokenUsage } from '../services/pricing.service';
import { reconcileUsage, releaseReservation } from '../services/quota.service';
import { withRetry } from '../services/retry';
import { errorForProtocol } from '../utils/errors';
import {
  createOpenAIStreamTransformer,
  extractOpenAIUsage,
  handleStreamAbort,
} from '../utils/streaming';

// Model families that use Foundry OpenAI-compatible endpoint
const FOUNDRY_FAMILIES = ['kimi', 'glm', 'minimax'];

/**
 * Build upstream URL based on model family
 */
export function buildUpstreamUrl(deployment: DeploymentConfig, modelFamily: string): string {
  const { endpoint, name, apiVersion } = deployment;

  if (FOUNDRY_FAMILIES.includes(modelFamily)) {
    return `${endpoint}/models/chat/completions?api-version=${apiVersion}`;
  }

  return `${endpoint}/openai/deployments/${name}/chat/completions?api-version=${apiVersion}`;
}

/**
 * Build request body for upstream
 */
export function buildRequestBody(
  body: Record<string, unknown>,
  modelFamily: string
): Record<string, unknown> {
  const upstream: Record<string, unknown> = { ...body };

  if (FOUNDRY_FAMILIES.includes(modelFamily)) {
    upstream.model = getDeploymentByAlias(body.model as string)?.azureModelName || body.model;
  }

  if (upstream.max_tokens && !upstream.max_completion_tokens) {
    upstream.max_completion_tokens = upstream.max_tokens;
    upstream.max_tokens = undefined;
  }

  return upstream;
}

/**
 * Proxy handler for non-streaming requests
 */
export async function proxyNonStreamingChat(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  reservationId: string
): Promise<Response> {
  const response = await withRetry(() =>
    fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );

  if (!response.ok) {
    recordFailure(deployment.name);
    const errorBody = await response.text();
    const error = errorForProtocol(
      '/v1/chat/completions',
      response.status,
      'bad_gateway',
      `Azure OpenAI error: ${response.status} ${errorBody}`
    );
    return new Response(JSON.stringify(error), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  recordSuccess(deployment.name);

  const responseBody = (await response.json()) as {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices?: Array<{
      index?: number;
      message?: { role: string; content: string };
      finish_reason?: string;
    }>;
    usage?: TokenUsage;
    error?: { message: string; type: string; code?: string };
  };
  const usage = responseBody?.usage;

  if (usage && reservationId) {
    await reconcileUsage(reservationId, usage, deployment.azureModelName);
  } else if (reservationId) {
    await releaseReservation(reservationId);
  }

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Proxy handler for streaming requests
 */
export async function proxyStreamingChat(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  reservationId: string,
  requestId: string
): Promise<Response> {
  const response = await withRetry(() =>
    fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        Accept: 'text/event-stream',
        'x-ms-client-request-id': requestId,
      },
      body: JSON.stringify({ ...body, stream: true }),
    })
  );

  if (!response.ok) {
    recordFailure(deployment.name);
    const errorBody = await response.text();
    const error = errorForProtocol(
      '/v1/chat/completions',
      response.status,
      'bad_gateway',
      `Azure OpenAI error: ${response.status} ${errorBody}`
    );
    return new Response(JSON.stringify(error), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  recordSuccess(deployment.name);

  if (!response.body) {
    return new Response('Internal Server Error: No response body', { status: 500 });
  }

  const transformer = createOpenAIStreamTransformer();
  let usageExtracted = false;
  handleStreamAbort(reservationId, releaseReservation);

  const stream = response.body.pipeThrough(new TransformStream(transformer)).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (!usageExtracted) {
          const text = new TextDecoder().decode(chunk);
          const usage = extractOpenAIUsage(text);
          if (usage) {
            usageExtracted = true;
            if (reservationId) {
              reconcileUsage(reservationId, usage, deployment.azureModelName).catch((err) =>
                console.error('Quota reconciliation error:', err)
              );
            }
          }
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        controller.terminate();
      },
    })
  );

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Request-Id': requestId,
    },
  });
}

// Create Hono app for mounting
const openaiChatProxy = new Hono();

openaiChatProxy.post('/', async (c) => {
  const deployment = c.get('deployment');
  const requestId = c.get('requestId') || '';
  const reservationId = c.get('reservationId') || '';

  // Check circuit breaker
  if (!isRequestAllowed(deployment.name)) {
    const error = errorForProtocol(
      '/v1/chat/completions',
      503,
      'service_unavailable',
      'Service temporarily unavailable, please retry'
    );
    return c.json(error, 503);
  }

  // Get auth headers
  const authManager = new AzureAuthManager();
  const authHeaders = await authManager.getAuthHeaders(deployment.name);

  // Parse body
  const body = await c.req.json<Record<string, unknown>>();

  // Build upstream request
  const upstreamUrl = buildUpstreamUrl(deployment, deployment.modelFamily);
  const upstreamBody = buildRequestBody(body, deployment.modelFamily);

  // Determine streaming
  if (body.stream === true) {
    return proxyStreamingChat(
      upstreamUrl,
      authHeaders,
      upstreamBody,
      deployment,
      reservationId,
      requestId
    );
  }

  return proxyNonStreamingChat(upstreamUrl, authHeaders, upstreamBody, deployment, reservationId);
});

// Export for testing and mounting
export { openaiChatProxy };
