/**
 * Messages Routes - /v1/messages
 * Anthropic Messages API endpoint with full middleware chain
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { protocolGuardMiddleware } from '../middleware/protocol-guard';
import { quotaMiddleware } from '../middleware/quota';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import { scopeMiddleware } from '../middleware/scope';
import {
  buildUpstreamUrlAnthropic,
  proxyNonStreamingAnthropic,
  proxyStreamingAnthropic,
} from '../proxy/anthropic.proxy';
import { createRequestHandler } from './factories/request-handler.factory';

// Zod schema for Anthropic messages body validation
const anthropicMessagesBodySchema = z.object({
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
  max_tokens: z.number().int().positive().min(1).default(4096),
});

export type AnthropicMessagesBody = z.infer<typeof anthropicMessagesBodySchema>;

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
