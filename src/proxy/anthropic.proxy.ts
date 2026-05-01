/**
 * Anthropic Messages Proxy
 * Proxies requests to Azure AI Foundry Anthropic API (Claude models)
 * Native passthrough - no transformation of request/response
 */

import type { DeploymentConfig } from '@/config/deployments';
import { logRequestAudit } from '@/db/data-access';
import { logger } from '@/observability/logger';
import { addLLMSpanAttributes } from '@/observability/tracing';
import type { ProxyRequestContext } from '@/routes/factories/types';
import { recordFailure, recordSuccess } from '@/services/circuit-breaker';
import type { TokenUsage } from '@/services/pricing.service';
import { reconcileUsage, releaseReservation } from '@/services/quota.service';
import { withRetry } from '@/services/retry';
import { errorForProtocol } from '@/utils/errors';
import { upstreamHttpsFetch } from '@/utils/fetch';
import {
  type AnthropicStreamEvent,
  handleStreamAbort,
  parseAnthropicEvents,
} from '@/utils/streaming';

function normalizeProxyContext(
  contextOrReservationId: ProxyRequestContext | string,
  requestId?: string
): ProxyRequestContext {
  if (typeof contextOrReservationId === 'string') {
    return { reservationId: contextOrReservationId, requestId: requestId || '' };
  }
  return contextOrReservationId;
}

async function releaseReservedQuota(reservationId: string, requestId: string): Promise<void> {
  if (!reservationId) {
    return;
  }

  try {
    await releaseReservation(reservationId);
  } catch (err) {
    logger.warn({ err, requestId, reservationId }, 'Failed to release quota reservation');
  }
}

/**
 * Build upstream URL for Anthropic Messages API
 */
export function buildUpstreamUrlAnthropic(deployment: DeploymentConfig): string {
  const { endpoint, apiVersion } = deployment;
  return `${endpoint}/anthropic/v1/messages?api-version=${apiVersion}`;
}

/**
 * Extract usage from Anthropic streaming events
 */
export function extractUsageFromAnthropicEvents(events: AnthropicStreamEvent[]): TokenUsage | null {
  for (const event of events) {
    if (event.type === 'message_delta' && event.usage) {
      return {
        prompt_tokens: event.usage.input_tokens,
        completion_tokens: event.usage.output_tokens,
        thinking_tokens: event.usage.thinking_tokens,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: undefined,
      };
    }
  }
  return null;
}

/**
 * Proxy non-streaming Anthropic request
 */
export async function proxyNonStreamingAnthropic(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  contextOrReservationId: ProxyRequestContext | string,
  legacyRequestId?: string
): Promise<Response> {
  const { reservationId, requestId, userId, abortSignal } = normalizeProxyContext(
    contextOrReservationId,
    legacyRequestId
  );
  const startTime = Date.now();
  const response = await withRetry(
    () =>
      upstreamHttpsFetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      }),
    { signal: abortSignal }
  );

  if (!response.ok) {
    await recordFailure(deployment.name);
    await releaseReservedQuota(reservationId, requestId);
    const errorBody = await response.text();
    const error = errorForProtocol(
      '/v1/messages',
      response.status,
      'api_error',
      `Azure AI Foundry error: ${response.status} ${errorBody}`
    );
    return new Response(JSON.stringify(error), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await recordSuccess(deployment.name);

  const responseBody = (await response.json()) as {
    type?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: TokenUsage;
    error?: { type: string; message: string };
  };
  const usage = responseBody?.usage;

  if (usage && reservationId) {
    const actualCost = await reconcileUsage(reservationId, usage, deployment.azureModelName);
    addLLMSpanAttributes({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.prompt_tokens + usage.completion_tokens,
      costUsd: actualCost.toNumber(),
    });
    logRequestAudit({
      userId: userId || 'unknown',
      requestId,
      model: deployment.azureModelName,
      deployment: deployment.name,
      protocolFamily: deployment.protocolFamily,
      tokensInput: usage.prompt_tokens,
      tokensOutput: usage.completion_tokens,
      tokensThinking: usage.thinking_tokens || 0,
      costUsd: actualCost.toString(),
      thinkingEnabled: false,
      azureAuthType: deployment.authConfig.type,
      durationMs: Date.now() - startTime,
      statusCode: 200,
    }).catch((err) => logger.warn({ err, requestId }, 'Failed to log request audit'));
  } else if (reservationId) {
    await releaseReservedQuota(reservationId, requestId);
  }

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Proxy streaming Anthropic request
 * Native SSE passthrough - only intercept usage from message_delta events
 */
export async function proxyStreamingAnthropic(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  contextOrReservationId: ProxyRequestContext | string,
  legacyRequestId?: string
): Promise<Response> {
  const { reservationId, requestId, userId, abortSignal } = normalizeProxyContext(
    contextOrReservationId,
    legacyRequestId
  );
  const response = await withRetry(
    () =>
      upstreamHttpsFetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...headers,
          Accept: 'text/event-stream',
          'x-ms-client-request-id': requestId,
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: abortSignal,
      }),
    { signal: abortSignal }
  );

  if (!response.ok) {
    await recordFailure(deployment.name);
    await releaseReservedQuota(reservationId, requestId);
    const errorBody = await response.text();
    const error = errorForProtocol(
      '/v1/messages',
      response.status,
      'api_error',
      `Azure AI Foundry error: ${response.status} ${errorBody}`
    );
    return new Response(JSON.stringify(error), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await recordSuccess(deployment.name);

  if (!response.body) {
    await releaseReservedQuota(reservationId, requestId);
    return new Response('Internal Server Error: No response body', { status: 500 });
  }

  let usageExtracted = false;
  let reservationFinalized = false;
  const startTime = Date.now();
  const releaseUnreconciled = async () => {
    if (reservationFinalized) {
      return;
    }
    reservationFinalized = true;
    await releaseReservedQuota(reservationId, requestId);
  };
  const cleanup = handleStreamAbort(reservationId, releaseUnreconciled, abortSignal);

  const stream = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);

        if (!usageExtracted && reservationId) {
          const text = new TextDecoder().decode(chunk);
          const events = parseAnthropicEvents(text);
          const usage = extractUsageFromAnthropicEvents(events);

          if (usage) {
            usageExtracted = true;
            reservationFinalized = true;
            reconcileUsage(reservationId, usage, deployment.azureModelName)
              .then((actualCost) => {
                addLLMSpanAttributes({
                  promptTokens: usage.prompt_tokens,
                  completionTokens: usage.completion_tokens,
                  totalTokens: usage.prompt_tokens + usage.completion_tokens,
                  costUsd: actualCost.toNumber(),
                });
                logRequestAudit({
                  userId: userId || 'unknown',
                  requestId,
                  model: deployment.azureModelName,
                  deployment: deployment.name,
                  protocolFamily: deployment.protocolFamily,
                  tokensInput: usage.prompt_tokens,
                  tokensOutput: usage.completion_tokens,
                  tokensThinking: usage.thinking_tokens || 0,
                  costUsd: actualCost.toString(),
                  thinkingEnabled: false,
                  azureAuthType: deployment.authConfig.type,
                  durationMs: Date.now() - startTime,
                  statusCode: 200,
                }).catch((err) => logger.warn({ err, requestId }, 'Failed to log request audit'));
              })
              .catch((err) => logger.error({ err, requestId }, 'Quota reconciliation error'));
          }
        }
      },
      async flush(controller) {
        await cleanup();
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
