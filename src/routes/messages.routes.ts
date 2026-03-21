/**
 * Messages Routes - /v1/messages
 * Anthropic Messages API endpoint with full middleware chain
 */

import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { protocolGuardMiddleware } from "../middleware/protocol-guard";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { quotaMiddleware } from "../middleware/quota";
import { getDeploymentByAlias } from "../config/deployments";
import { buildUpstreamUrlAnthropic, proxyNonStreamingAnthropic, proxyStreamingAnthropic } from "../proxy/anthropic.proxy";
import { AzureAuthManager } from "../services/azure-auth";
import { isRequestAllowed } from "../services/circuit-breaker";
import { errorForProtocol } from "../utils/errors";

// Zod schema for Anthropic messages body validation
const anthropicMessagesBodySchema = z.object({
  model: z.string().min(1, "model is required"),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.union([z.string(), z.array(z.object({
        type: z.enum(["text", "tool_use", "tool_result"]),
        text: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        input: z.record(z.unknown()).optional(),
      }))]),
    })
  ).min(1, "messages are required"),
  stream: z.boolean().optional().default(false),
  system: z.union([z.string(), z.array(z.object({
    type: z.literal("text"),
    text: z.string(),
  }))]).optional(),
  thinking: z.object({
    type: z.enum(["enabled", "disabled"]),
    budget_tokens: z.number().int().positive().optional(),
  }).optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()),
  })).optional(),
  tool_choice: z.object({
    type: z.enum(["auto", "any", "tool"]),
    name: z.string().optional(),
  }).optional(),
  max_tokens: z.number().int().positive().min(1).default(4096),
});

export type AnthropicMessagesBody = z.infer<typeof anthropicMessagesBodySchema>;

// Create messages routes
export const messagesRoutes = new Hono();

// Apply middleware chain
messagesRoutes.use("*", authMiddleware);
messagesRoutes.use("*", protocolGuardMiddleware);
messagesRoutes.use("*", rateLimitMiddleware);
messagesRoutes.use("*", quotaMiddleware);

// POST /v1/messages
messagesRoutes.post("/", async (c) => {
  // Parse body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    const error = errorForProtocol(c.req.path, 400, "invalid_request", "Invalid JSON body");
    c.status(400);
    return c.json(error);
  }

  // Validate body
  const parsed = anthropicMessagesBodySchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    const error = errorForProtocol(
      c.req.path,
      400,
      "invalid_request",
      `${firstError.path.join(".")}: ${firstError.message}`
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
      "model_not_supported",
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
      "overloaded_error",
      "Service temporarily unavailable, please retry"
    );
    return c.json(error, 503);
  }

  // Get auth headers
  const authManager = new AzureAuthManager();
  const authHeaders = await authManager.getAuthHeaders(deployment.name);

  // Build upstream request
  const upstreamUrl = buildUpstreamUrlAnthropic(deployment);

  // Get context values
  const requestId = c.get("requestId") || "";
  const reservationId = c.get("reservationId") || "";

  // Determine streaming
  if (validatedBody.stream) {
    return proxyStreamingAnthropic(upstreamUrl, authHeaders, validatedBody as Record<string, unknown>, deployment, reservationId, requestId);
  }

  return proxyNonStreamingAnthropic(upstreamUrl, authHeaders, validatedBody as Record<string, unknown>, deployment, reservationId);
});
