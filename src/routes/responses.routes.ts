/**
 * Responses Routes - /v1/responses
 * OpenAI Responses API endpoint with full middleware chain
 */

import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { protocolGuardMiddleware } from "../middleware/protocol-guard";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { quotaMiddleware } from "../middleware/quota";
import { getDeploymentByAlias } from "../config/deployments";
import { buildUpstreamUrl, buildRequestBody, proxyNonStreamingChat, proxyStreamingChat } from "../proxy/openai-chat.proxy";
import { AzureAuthManager } from "../services/azure-auth";
import { isRequestAllowed } from "../services/circuit-breaker";
import { errorForProtocol } from "../utils/errors";

// Zod schema for Responses API body validation
const responsesBodySchema = z.object({
  model: z.string().min(1, "model is required"),
  input: z.union([
    z.string(),
    z.array(z.object({
      role: z.enum(["user"]),
      content: z.string(),
    })),
  ]),
  stream: z.boolean().optional().default(false),
  tools: z.array(z.object({
    type: z.literal("function"),
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()),
  })).optional(),
  reasoning: z.object({
    effort: z.enum(["low", "medium", "high"]),
  }).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  user: z.string().optional(),
});

export type ResponsesBody = z.infer<typeof responsesBodySchema>;

// Create responses routes
export const responsesRoutes = new Hono();

// Apply middleware chain
responsesRoutes.use("*", authMiddleware);
responsesRoutes.use("*", protocolGuardMiddleware);
responsesRoutes.use("*", rateLimitMiddleware);
responsesRoutes.use("*", quotaMiddleware);

// POST /v1/responses
responsesRoutes.post("/", async (c) => {
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
  const parsed = responsesBodySchema.safeParse(body);
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
      "service_unavailable",
      "Service temporarily unavailable, please retry"
    );
    return c.json(error, 503);
  }

  // Transform Responses API to Chat Completions format
  const chatCompletionsBody = transformToChatCompletions(validatedBody);

  // Get auth headers
  const authManager = new AzureAuthManager();
  const authHeaders = await authManager.getAuthHeaders(deployment.name);

  // Build upstream request
  const upstreamUrl = buildUpstreamUrl(deployment, deployment.modelFamily);
  const upstreamBody = buildRequestBody(chatCompletionsBody, deployment.modelFamily);

  // Get context values
  const requestId = c.get("requestId") || "";
  const reservationId = c.get("reservationId") || "";

  // Determine streaming
  if (validatedBody.stream) {
    return proxyStreamingChat(upstreamUrl, authHeaders, upstreamBody, deployment, reservationId, requestId);
  }

  return proxyNonStreamingChat(upstreamUrl, authHeaders, upstreamBody, deployment, reservationId);
});

/**
 * Transform Responses API request to Chat Completions format
 */
function transformToChatCompletions(body: ResponsesBody): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];

  // Transform input to messages
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      messages.push({ role: item.role, content: item.content });
    }
  }

  // Transform tools if present
  let functions: Array<{ name: string; description?: string; parameters: Record<string, unknown> }> | undefined;
  if (body.tools && body.tools.length > 0) {
    functions = body.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  return {
    model: body.model,
    messages,
    stream: body.stream,
    max_tokens: body.max_tokens,
    max_completion_tokens: body.max_completion_tokens,
    temperature: body.temperature,
    user: body.user,
    functions,
  };
}
