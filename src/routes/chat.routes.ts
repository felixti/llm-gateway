/**
 * Chat Routes - /v1/chat/completions
 * OpenAI Chat Completions API endpoint with full middleware chain
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getDeploymentByAlias } from '../config/deployments';
import { authMiddleware } from '../middleware/auth';
import { protocolGuardMiddleware } from '../middleware/protocol-guard';
import { quotaMiddleware } from '../middleware/quota';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import {
  buildRequestBody,
  buildUpstreamUrl,
  proxyNonStreamingChat,
  proxyStreamingChat,
} from '../proxy/openai-chat.proxy';
import { AzureAuthManager } from '../services/azure-auth';
import { isRequestAllowed } from '../services/circuit-breaker';
import { errorForProtocol } from '../utils/errors';

// Zod schema for chat completions body validation
const chatCompletionsBodySchema = z.object({
  model: z.string().min(1, 'model is required'),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'function']),
        content: z.union([z.string(), z.null()]),
        name: z.string().optional(),
      })
    )
    .min(1, 'messages are required'),
  stream: z.boolean().optional().default(false),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  logit_bias: z.record(z.number()).optional(),
  user: z.string().optional(),
  functions: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.record(z.unknown()),
      })
    )
    .optional(),
  function_call: z
    .union([
      z.string(),
      z.object({
        name: z.string(),
        arguments: z.record(z.unknown()),
      }),
    ])
    .optional(),
});

export type ChatCompletionsBody = z.infer<typeof chatCompletionsBodySchema>;

// Create chat routes
export const chatRoutes = new Hono();

// Apply middleware chain
chatRoutes.use('*', authMiddleware);
chatRoutes.use('*', protocolGuardMiddleware);
chatRoutes.use('*', rateLimitMiddleware);
chatRoutes.use('*', quotaMiddleware);

// POST /v1/chat/completions
chatRoutes.post('/', async (c) => {
  // Parse body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    const error = errorForProtocol(c.req.path, 400, 'invalid_request', 'Invalid JSON body');
    c.status(400);
    return c.json(error);
  }

  // Validate body
  const parsed = chatCompletionsBodySchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    const error = errorForProtocol(
      c.req.path,
      400,
      'invalid_request',
      `${firstError.path.join('.')}: ${firstError.message}`
    );
    c.status(400);
    return c.json(error);
  }

  const validatedBody = parsed.data;

  // Get deployment
  const deployment = getDeploymentByAlias(validatedBody.model);
  if (!deployment) {
    const error = errorForProtocol(
      c.req.path,
      400,
      'model_not_supported',
      `Unknown model: ${validatedBody.model}`
    );
    c.status(400);
    return c.json(error);
  }

  // Check circuit breaker
  if (!isRequestAllowed(deployment.name)) {
    const error = errorForProtocol(
      c.req.path,
      503,
      'service_unavailable',
      'Service temporarily unavailable, please retry'
    );
    return c.json(error, 503);
  }

  // Get auth headers
  const authManager = new AzureAuthManager();
  const authHeaders = await authManager.getAuthHeaders(deployment.name);

  // Build upstream request
  const upstreamUrl = buildUpstreamUrl(deployment, deployment.modelFamily);
  const upstreamBody = buildRequestBody(
    validatedBody as Record<string, unknown>,
    deployment.modelFamily
  );

  // Get context values
  const requestId = c.get('requestId') || '';
  const reservationId = c.get('reservationId') || '';

  // Determine streaming
  if (validatedBody.stream) {
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
