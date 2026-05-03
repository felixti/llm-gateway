/**
 * Anthropic Messages Proxy
 * Proxies requests to Azure AI Foundry Anthropic API (Claude models)
 * Native passthrough - no transformation of request/response
 */

import type { DeploymentConfig } from '@/config/deployments';
import { logRequestAudit } from '@/db/data-access';
import { logger } from '@/observability/logger';
import { incrementAzureRateLimitHits } from '@/observability/metrics';
import { addLLMSpanAttributes } from '@/observability/tracing';
import type { ProxyRequestContext } from '@/routes/factories/types';
import { recordFailure, recordSuccess } from '@/services/circuit-breaker';
import type { TokenUsage } from '@/services/pricing.service';
import { reconcileUsage } from '@/services/quota.service';
import { withRetry } from '@/services/retry';
import { upstreamHttpsFetch } from '@/utils/fetch';
import { AsyncMutex } from '@/utils/mutex';
import {
  type AnthropicStreamEvent,
  handleStreamAbort,
  parseAnthropicEvents,
} from '@/utils/streaming';
import {
  createSanitizedUpstreamErrorResponse,
  finalizeProxyUsage,
  normalizeProxyContext,
  releaseReservedQuota,
} from './shared';

/**
 * Build upstream URL for Anthropic Messages API
 */
export function buildUpstreamUrlAnthropic(deployment: DeploymentConfig): string {
  const { endpoint, apiVersion } = deployment;
  return `${endpoint}/anthropic/v1/messages?api-version=${apiVersion}`;
}

/**
 * Build upstream URL for Anthropic Messages API token counting (Messages API compatible)
 */
export function buildUpstreamUrlAnthropicCountTokens(deployment: DeploymentConfig): string {
  const { endpoint, apiVersion } = deployment;
  return `${endpoint}/anthropic/v1/messages/count_tokens?api-version=${apiVersion}`;
}

/**
 * Proxy token-count request — no quota reconcile (metadata-only upstream call).
 */
export async function proxyCountTokensAnthropic(
  upstreamUrl: string,
  azureAuthHeaders: Record<string, string>,
  anthropicClientHeaders: { version?: string | null; beta?: string | null },
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  context: Pick<ProxyRequestContext, 'requestId' | 'userId' | 'abortSignal'>
): Promise<Response> {
  const { requestId, abortSignal } = context;
  const anthropicVersion = anthropicClientHeaders.version ?? '2023-06-01';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': anthropicVersion,
    ...azureAuthHeaders,
  };
  if (anthropicClientHeaders.beta) {
    headers['anthropic-beta'] = anthropicClientHeaders.beta;
  }

  let response: Response;
  try {
    response = await withRetry(
      () =>
        upstreamHttpsFetch(upstreamUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
        }),
      { signal: abortSignal }
    );
  } catch (error: unknown) {
    if (
      (error instanceof Error && error.name === 'AbortError') ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw error;
    }
    logger.warn(
      { err: error, requestId, deployment: deployment.name },
      'Upstream network request failed'
    );
    await recordFailure(deployment.name);
    return createSanitizedUpstreamErrorResponse({
      path: '/v1/messages/count_tokens',
      errorCode: 'bad_gateway',
      upstreamName: 'Azure AI Foundry',
      requestId,
      deploymentName: deployment.name,
    });
  }

  if (!response.ok) {
    if (response.status === 429) {
      incrementAzureRateLimitHits();
    } else {
      await recordFailure(deployment.name);
    }
    return createSanitizedUpstreamErrorResponse({
      response,
      path: '/v1/messages/count_tokens',
      errorCode: 'api_error',
      upstreamName: 'Azure AI Foundry',
      requestId,
      deploymentName: deployment.name,
    });
  }

  await recordSuccess(deployment.name);

  const responseBody = await response.json();
  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    },
  });
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
  let response: Response;
  try {
    response = await withRetry(
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
  } catch (error: unknown) {
    if (
      (error instanceof Error && error.name === 'AbortError') ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw error;
    }
    logger.warn(
      { err: error, requestId, deployment: deployment.name },
      'Upstream network request failed'
    );
    await recordFailure(deployment.name);
    return createSanitizedUpstreamErrorResponse({
      path: '/v1/messages',
      errorCode: 'bad_gateway',
      upstreamName: 'Azure AI Foundry',
      requestId,
      deploymentName: deployment.name,
    });
  }

  if (!response.ok) {
    if (response.status === 429) {
      incrementAzureRateLimitHits();
    } else {
      await recordFailure(deployment.name);
    }
    // Do NOT release reservation — factory may try fallback with same reservationId
    return createSanitizedUpstreamErrorResponse({
      response,
      path: '/v1/messages',
      errorCode: 'api_error',
      upstreamName: 'Azure AI Foundry',
      requestId,
      deploymentName: deployment.name,
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

  await finalizeProxyUsage({ usage, reservationId, requestId, userId, deployment, startTime });

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
  let response: Response;
  try {
    response = await withRetry(
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
  } catch (error: unknown) {
    if (
      (error instanceof Error && error.name === 'AbortError') ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw error;
    }
    logger.warn(
      { err: error, requestId, deployment: deployment.name },
      'Upstream network request failed'
    );
    await recordFailure(deployment.name);
    return createSanitizedUpstreamErrorResponse({
      path: '/v1/messages',
      errorCode: 'bad_gateway',
      upstreamName: 'Azure AI Foundry',
      requestId,
      deploymentName: deployment.name,
    });
  }

  if (!response.ok) {
    if (response.status === 429) {
      incrementAzureRateLimitHits();
    } else {
      await recordFailure(deployment.name);
    }
    // Do NOT release reservation — factory may try fallback with same reservationId
    return createSanitizedUpstreamErrorResponse({
      response,
      path: '/v1/messages',
      errorCode: 'api_error',
      upstreamName: 'Azure AI Foundry',
      requestId,
      deploymentName: deployment.name,
    });
  }

  await recordSuccess(deployment.name);

  if (!response.body) {
    await releaseReservedQuota(reservationId, requestId);
    return new Response('Internal Server Error: No response body', { status: 500 });
  }

  let usageExtracted = false;
  let reservationFinalized = false;
  const finalizeMutex = new AsyncMutex();
  const startTime = Date.now();
  const releaseUnreconciled = async () => {
    const release = await finalizeMutex.acquire();
    try {
      if (reservationFinalized) return;
      reservationFinalized = true;
      await releaseReservedQuota(reservationId, requestId);
    } finally {
      release();
    }
  };
  const cleanup = handleStreamAbort(reservationId, releaseUnreconciled, abortSignal);

  // Stateful decoder retained across chunks to handle multi-byte UTF-8
  // characters that may span chunk boundaries.
  const decoder = new TextDecoder();
  let textBuffer = '';

  const stream = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);

        if (!usageExtracted && reservationId) {
          textBuffer += decoder.decode(chunk, { stream: true });
          const events = parseAnthropicEvents(textBuffer);
          const usage = extractUsageFromAnthropicEvents(events);

          if (usage) {
            // Don't block stream - fire-and-forget with mutex
            (async () => {
              const release = await finalizeMutex.acquire();
              try {
                if (usageExtracted || reservationFinalized) return;
                usageExtracted = true;
                reservationFinalized = true;

                const actualCost = await reconcileUsage(
                  reservationId,
                  usage,
                  deployment.azureModelName
                );
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
              } finally {
                release();
              }
            })();
          }
        }
      },
      async flush(controller) {
        // Flush any remaining buffered bytes from the decoder
        textBuffer += decoder.decode();
        if (!usageExtracted && reservationId && textBuffer) {
          const events = parseAnthropicEvents(textBuffer);
          const usage = extractUsageFromAnthropicEvents(events);
          if (usage) {
            usageExtracted = true;
            const release = await finalizeMutex.acquire();
            try {
              if (reservationFinalized) return;
              reservationFinalized = true;
              const actualCost = await reconcileUsage(
                reservationId,
                usage,
                deployment.azureModelName
              );
              addLLMSpanAttributes({
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.prompt_tokens + usage.completion_tokens,
                costUsd: actualCost.toNumber(),
              });
            } finally {
              release();
            }
          }
        }
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
