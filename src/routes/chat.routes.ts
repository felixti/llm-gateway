/**
 * Chat Routes - /v1/chat/completions
 * OpenAI Chat Completions API endpoint with full middleware chain
 */

import { Hono } from 'hono';
import { z } from 'zod';
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
import { createRequestHandler } from './factories/request-handler.factory';

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

// Create handler using factory
const handleChatRequest = createRequestHandler({
  schema: chatCompletionsBodySchema,
  protocol: 'openai',
  path: '/v1/chat/completions',
  proxyStreaming: proxyStreamingChat,
  proxyNonStreaming: proxyNonStreamingChat,
  getModel: (body: Record<string, unknown>) => body.model as string,
  buildUpstreamUrl: (deployment) => buildUpstreamUrl(deployment, deployment.modelFamily),
  transformBody: (body: Record<string, unknown>, deployment) =>
    buildRequestBody(body, deployment.modelFamily),
});

// Create chat routes
export const chatRoutes = new Hono();

// Apply middleware chain
chatRoutes.use('*', authMiddleware);
chatRoutes.use('*', protocolGuardMiddleware);
chatRoutes.use('*', rateLimitMiddleware);
chatRoutes.use('*', quotaMiddleware);

// POST /v1/chat/completions
chatRoutes.post('/', handleChatRequest);
