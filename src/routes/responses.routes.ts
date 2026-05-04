/**
 * Responses Routes - /v1/responses
 * OpenAI Responses API endpoint with full middleware chain
 */

import { authMiddleware } from '@/middleware/auth';
import { protocolGuardMiddleware } from '@/middleware/protocol-guard';
import { quotaMiddleware } from '@/middleware/quota';
import { rateLimitMiddleware } from '@/middleware/rate-limit';
import { scopeMiddleware } from '@/middleware/scope';
import { buildRequestBody, buildUpstreamUrl } from '@/proxy/openai-chat.proxy';
import {
  proxyNonStreamingResponses,
  proxyStreamingResponses,
  transformResponsesToChatCompletions,
} from '@/proxy/openai-responses.proxy';
import { Hono } from 'hono';
import { z } from 'zod';
import { createRequestHandler } from './factories/request-handler.factory';

// Zod schema for Responses API body validation
export const responsesBodySchema = z
  .object({
    model: z.string().min(1, 'model is required'),
    input: z.union([
      z.string(),
      z.array(
        z
          .object({
            type: z.string().optional(),
            role: z.enum(['user', 'assistant', 'system', 'developer']).optional(),
            content: z.unknown().optional(),
            call_id: z.string().optional(),
            output: z.unknown().optional(),
            name: z.string().optional(),
            arguments: z.unknown().optional(),
          })
          .passthrough()
      ),
    ]),
    stream: z.boolean().optional().default(false),
    tools: z
      .array(
        z
          .object({
            type: z.string(),
            name: z.string().optional(),
            description: z.string().optional(),
            parameters: z.record(z.unknown()).optional(),
            function: z
              .object({
                name: z.string().optional(),
                description: z.string().optional(),
                parameters: z.record(z.unknown()).optional(),
              })
              .optional(),
          })
          .passthrough()
      )
      .optional(),
    reasoning: z
      .object({
        effort: z.enum(['low', 'medium', 'high']),
      })
      .optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    user: z.string().optional(),
    stream_options: z.record(z.unknown()).optional(),
    modalities: z.array(z.string()).optional(),
    response_format: z.record(z.unknown()).optional(),
    tool_choice: z.union([z.string(), z.object({})]).optional(),
  })
  .passthrough();

export type ResponsesBody = z.infer<typeof responsesBodySchema>;

// Create handler using factory
const handleResponsesRequest = createRequestHandler({
  schema: responsesBodySchema,
  protocol: 'openai',
  path: '/v1/responses',
  proxyStreaming: proxyStreamingResponses,
  proxyNonStreaming: proxyNonStreamingResponses,
  getModel: (body: Record<string, unknown>) => body.model as string,
  buildUpstreamUrl: (deployment) => buildUpstreamUrl(deployment, deployment.modelFamily),
  transformBody: (body, deployment) =>
    buildRequestBody(transformResponsesToChatCompletions(body), deployment.modelFamily),
});

// Create responses routes
export const responsesRoutes = new Hono();

// Apply middleware chain
responsesRoutes.use('*', authMiddleware);
responsesRoutes.use('*', scopeMiddleware);
responsesRoutes.use('*', protocolGuardMiddleware);
responsesRoutes.use('*', rateLimitMiddleware);
responsesRoutes.use('*', quotaMiddleware);

// POST /v1/responses
responsesRoutes.post('/', handleResponsesRequest);
