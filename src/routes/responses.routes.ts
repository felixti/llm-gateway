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
        z.object({
          role: z.enum(['user']),
          content: z.string(),
        })
      ),
    ]),
    stream: z.boolean().optional().default(false),
    tools: z
      .array(
        z.object({
          type: z.literal('function'),
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.unknown()),
        })
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

/**
 * Transform Responses API request to Chat Completions format
 */
function transformToChatCompletions(body: Record<string, unknown>): Record<string, unknown> {
  const typedBody = body as ResponsesBody;
  const messages: Array<{ role: string; content: string }> = [];

  // Transform input to messages
  if (typeof typedBody.input === 'string') {
    messages.push({ role: 'user', content: typedBody.input });
  } else if (Array.isArray(typedBody.input)) {
    for (const item of typedBody.input) {
      messages.push({ role: item.role, content: item.content });
    }
  }

  // Transform tools if present
  type Tool = {
    type: 'function';
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
  let functions:
    | Array<{ name: string; description?: string; parameters: Record<string, unknown> }>
    | undefined;
  if (typedBody.tools && typedBody.tools.length > 0) {
    functions = typedBody.tools.map((tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  return {
    model: typedBody.model,
    messages,
    stream: typedBody.stream,
    max_tokens: typedBody.max_tokens,
    max_completion_tokens: typedBody.max_completion_tokens,
    temperature: typedBody.temperature,
    user: typedBody.user,
    functions,
  };
}

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
    buildRequestBody(transformToChatCompletions(body), deployment.modelFamily),
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
