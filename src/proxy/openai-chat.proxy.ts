/**
 * OpenAI Chat Completions Proxy
 * Proxies requests to Azure OpenAI (GPT) and Azure AI Foundry (Kimi/GLM/MiniMax)
 * Handles streaming with usage extraction and quota reconciliation
 */

import type { DeploymentConfig } from '@/config/deployments';
import { getDeploymentByAlias } from '@/config/deployments';
import { logRequestAudit } from '@/db/data-access';
import { addLLMSpanAttributes, injectTraceContext } from '@/observability/tracing';
import { AzureAuthManager } from '@/services/azure-auth';
import { isRequestAllowed, recordFailure, recordSuccess } from '@/services/circuit-breaker';
import type { TokenUsage } from '@/services/pricing.service';
import { calculateCost } from '@/services/pricing.service';
import { reconcileUsage, releaseReservation } from '@/services/quota.service';
import { withRetry } from '@/services/retry';
import { errorForProtocol } from '@/utils/errors';
import {
  createOpenAIStreamTransformer,
  extractOpenAIUsage,
  handleStreamAbort,
} from '@/utils/streaming';

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
  reservationId: string,
  requestId: string
): Promise<Response> {
  const startTime = Date.now();
  const traceHeaders = injectTraceContext(headers, requestId);
  const response = await withRetry(() =>
    fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...traceHeaders,
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
  const userId = deployment.name;

  if (usage && reservationId) {
    const actualCost = await reconcileUsage(reservationId, usage, deployment.azureModelName);
    addLLMSpanAttributes({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.prompt_tokens + usage.completion_tokens,
      costUsd: actualCost.toNumber(),
    });
    logRequestAudit({
      userId,
      requestId,
      model: deployment.azureModelName,
      deployment: deployment.name,
      protocolFamily: deployment.protocolFamily,
      tokensInput: usage.prompt_tokens,
      tokensOutput: usage.completion_tokens,
      tokensThinking: usage.thinking_tokens || 0,
      costUsd: actualCost.toString(),
      thinkingEnabled: false,
      azureAuthType: 'api_key',
      durationMs: Date.now() - startTime,
      statusCode: 200,
    }).catch(() => {});
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
  const startTime = Date.now();
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
              reconcileUsage(reservationId, usage, deployment.azureModelName)
                .then((actualCost) => {
                  addLLMSpanAttributes({
                    promptTokens: usage.prompt_tokens,
                    completionTokens: usage.completion_tokens,
                    totalTokens: usage.prompt_tokens + usage.completion_tokens,
                    costUsd: actualCost.toNumber(),
                  });
                  logRequestAudit({
                    userId: deployment.name,
                    requestId,
                    model: deployment.azureModelName,
                    deployment: deployment.name,
                    protocolFamily: deployment.protocolFamily,
                    tokensInput: usage.prompt_tokens,
                    tokensOutput: usage.completion_tokens,
                    tokensThinking: usage.thinking_tokens || 0,
                    costUsd: actualCost.toString(),
                    thinkingEnabled: false,
                    azureAuthType: 'api_key',
                    durationMs: Date.now() - startTime,
                    statusCode: 200,
                  }).catch(() => {});
                })
                .catch((err) => console.error('Quota reconciliation error:', err));
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
