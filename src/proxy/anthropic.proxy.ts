/**
 * Anthropic Messages Proxy
 * Proxies requests to Azure AI Foundry Anthropic API (Claude models)
 * Native passthrough - no transformation of request/response
 */

import type { DeploymentConfig } from '../config/deployments';
import { recordFailure, recordSuccess } from '../services/circuit-breaker';
import type { TokenUsage } from '../services/pricing.service';
import { reconcileUsage, releaseReservation } from '../services/quota.service';
import { withRetry } from '../services/retry';
import { errorForProtocol } from '../utils/errors';
import {
  type AnthropicStreamEvent,
  handleStreamAbort,
  parseAnthropicEvents,
} from '../utils/streaming';

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
  reservationId: string
): Promise<Response> {
  const response = await withRetry(() =>
    fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );

  if (!response.ok) {
    recordFailure(deployment.name);
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

  recordSuccess(deployment.name);

  const responseBody = (await response.json()) as {
    type?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: TokenUsage;
    error?: { type: string; message: string };
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
 * Proxy streaming Anthropic request
 * Native SSE passthrough - only intercept usage from message_delta events
 */
export async function proxyStreamingAnthropic(
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
        'anthropic-version': '2023-06-01',
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

  recordSuccess(deployment.name);

  if (!response.body) {
    return new Response('Internal Server Error: No response body', { status: 500 });
  }

  let usageExtracted = false;
  const cleanup = handleStreamAbort(reservationId, releaseReservation);

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
            reconcileUsage(reservationId, usage, deployment.azureModelName).catch((err) =>
              console.error('Quota reconciliation error:', err)
            );
          }
        }
      },
      flush(controller) {
        cleanup();
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
