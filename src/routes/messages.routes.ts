/**
 * Messages Routes - /v1/messages
 * Anthropic Messages API endpoint with full middleware chain
 */

import { getDeploymentByAlias } from '@/config/deployments';
import { authMiddleware } from '@/middleware/auth';
import { protocolGuardMiddleware } from '@/middleware/protocol-guard';
import { quotaMiddleware } from '@/middleware/quota';
import { rateLimitMiddleware } from '@/middleware/rate-limit';
import { scopeMiddleware } from '@/middleware/scope';
import { REQUEST_SIGNAL_KEY } from '@/middleware/timeout';
import { getRequestBodyLogMetadata, logDebugRequestMetadata } from '@/observability/logger';
import {
  addLLMSpanAttributes,
  getCurrentTraceId,
  recordError,
  withSpan,
} from '@/observability/tracing';
import {
  buildUpstreamUrlAnthropic,
  buildUpstreamUrlAnthropicCountTokens,
  proxyCountTokensAnthropic,
  proxyNonStreamingAnthropic,
  proxyStreamingAnthropic,
} from '@/proxy/anthropic.proxy';
import { getAzureAuthManager } from '@/services/azure-auth';
import { isRequestAllowed } from '@/services/circuit-breaker';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { createRequestErrorResponse, validateBody } from './factories/errors';
import { createRequestHandler } from './factories/request-handler.factory';

/** Stable path for Anthropic-shaped errors (matches client-facing `/v1/messages/count_tokens`). */
const COUNT_TOKENS_ROUTE_FOR_ERRORS = '/v1/messages/count_tokens';

// Zod schema for Anthropic messages body validation
export const anthropicMessagesBodySchema = z
  .object({
    model: z.string().min(1, 'model is required'),
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.union([
            z.string(),
            z.array(
              z.object({
                type: z.enum(['text', 'tool_use', 'tool_result']),
                text: z.string().optional(),
                id: z.string().optional(),
                name: z.string().optional(),
                input: z.record(z.unknown()).optional(),
              })
            ),
          ]),
        })
      )
      .min(1, 'messages are required'),
    stream: z.boolean().optional().default(false),
    system: z
      .union([
        z.string(),
        z.array(
          z.object({
            type: z.literal('text'),
            text: z.string(),
          })
        ),
      ])
      .optional(),
    thinking: z
      .object({
        type: z.enum(['enabled', 'disabled']),
        budget_tokens: z.number().int().positive().optional(),
      })
      .optional(),
    tools: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          input_schema: z.record(z.unknown()),
        })
      )
      .optional(),
    tool_choice: z
      .object({
        type: z.enum(['auto', 'any', 'tool']),
        name: z.string().optional(),
      })
      .optional(),
    max_tokens: z.number().int().positive().min(1),
    stream_options: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type AnthropicMessagesBody = z.infer<typeof anthropicMessagesBodySchema>;

/** POST /v1/messages/count_tokens — no `max_tokens` (Anthropic Token Count API). */
export const anthropicCountTokensBodySchema = anthropicMessagesBodySchema
  .omit({ max_tokens: true })
  .passthrough();

export type AnthropicCountTokensBody = z.infer<typeof anthropicCountTokensBodySchema>;

async function handleCountTokensRequest(c: Context): Promise<Response> {
  const pathForErrors = COUNT_TOKENS_ROUTE_FOR_ERRORS;
  const requestId = c.get('requestId') || '';
  const userId = c.get('userId');
  const signal = (c.get(REQUEST_SIGNAL_KEY) as AbortSignal | undefined) ?? c.req.raw.signal;

  return withSpan(
    'gateway.request',
    async (span) => {
      const startTime = Date.now();

      let bodyUnknown: unknown = c.get('parsedBody');
      if (bodyUnknown === undefined || bodyUnknown === null) {
        try {
          const parsed = await c.req.json();
          bodyUnknown = parsed;
          if (typeof parsed === 'object' && parsed !== null) {
            c.set('parsedBody', parsed as Record<string, unknown>);
          }
        } catch {
          return createRequestErrorResponse(c, pathForErrors, {
            type: 'invalid_json',
            message: 'Invalid JSON body',
          });
        }
      }

      if (typeof bodyUnknown !== 'object' || bodyUnknown === null) {
        return createRequestErrorResponse(c, pathForErrors, {
          type: 'invalid_json',
          message: 'Request body must be an object',
        });
      }

      const validatedBody = validateBody<{ [key: string]: unknown }>(
        bodyUnknown,
        anthropicCountTokensBodySchema
      );
      if (!validatedBody.ok) {
        return createRequestErrorResponse(c, pathForErrors, validatedBody.error);
      }

      const bodyRecord = validatedBody.value;

      logDebugRequestMetadata('request', getRequestBodyLogMetadata(bodyRecord), {
        traceId: getCurrentTraceId(),
        userId,
      });

      const model = bodyRecord.model as string;
      const deployment = getDeploymentByAlias(model);
      if (!deployment) {
        return createRequestErrorResponse(c, pathForErrors, {
          type: 'deployment_not_found',
          model,
        });
      }

      addLLMSpanAttributes({
        userId,
        model,
        deployment: deployment.name,
        protocol: 'anthropic',
        authType: deployment.authConfig.type,
      });

      const circuitAllowed = await isRequestAllowed(deployment.name);
      if (!circuitAllowed) {
        return createRequestErrorResponse(c, pathForErrors, {
          type: 'circuit_open',
          message: 'Service temporarily unavailable',
        });
      }

      const authManager = getAzureAuthManager();
      let authHeaders: Record<string, string>;
      try {
        authHeaders = await authManager.getAuthHeadersForDeployment(deployment);
      } catch {
        return createRequestErrorResponse(c, pathForErrors, {
          type: 'authentication_error',
          message: 'Failed to get authentication credentials',
        });
      }

      const upstreamUrl = buildUpstreamUrlAnthropicCountTokens(deployment);
      const response = await proxyCountTokensAnthropic(
        upstreamUrl,
        authHeaders,
        {
          version: c.req.header('anthropic-version'),
          beta: c.req.header('anthropic-beta'),
        },
        bodyRecord,
        deployment,
        { requestId, userId, abortSignal: signal }
      );

      span.setAttribute('http.status_code', response.status);
      span.setAttribute('duration_ms', Date.now() - startTime);

      logDebugRequestMetadata(
        'response',
        { status: response.status },
        { traceId: getCurrentTraceId(), userId }
      );

      if (!response.ok) {
        recordError(new Error(`Upstream returned ${response.status}`));
      }

      return response;
    },
    {
      'http.method': c.req.method,
      'http.route': c.req.path,
      'http.target': c.req.url,
    }
  );
}

// Create handler using factory
const handleMessagesRequest = createRequestHandler({
  schema: anthropicMessagesBodySchema,
  protocol: 'anthropic',
  path: '/v1/messages',
  proxyStreaming: proxyStreamingAnthropic,
  proxyNonStreaming: proxyNonStreamingAnthropic,
  getModel: (body: Record<string, unknown>) => body.model as string,
  buildUpstreamUrl: (deployment) => buildUpstreamUrlAnthropic(deployment),
});

// Create messages routes
export const messagesRoutes = new Hono();

// Apply middleware chain
messagesRoutes.use('*', authMiddleware);
messagesRoutes.use('*', scopeMiddleware);
messagesRoutes.use('*', protocolGuardMiddleware);
messagesRoutes.use('*', rateLimitMiddleware);
messagesRoutes.use('*', quotaMiddleware);

// POST /v1/messages
messagesRoutes.post('/', handleMessagesRequest);

// POST /v1/messages/count_tokens
messagesRoutes.post('/count_tokens', handleCountTokensRequest);
