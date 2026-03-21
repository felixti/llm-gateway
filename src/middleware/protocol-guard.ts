/**
 * Protocol Guard Middleware
 * Validates model-to-endpoint compatibility
 * Rejects Claude models on /v1/chat/completions and /v1/responses
 * Rejects non-Claude models on /v1/messages
 */

import type { Context, Next } from "hono";
import { getModelFamily, type ModelFamily } from "../config/deployments";
import { errorForProtocol } from "../utils/errors";

// Model families allowed per endpoint
const ALLOWED_FAMILIES_PER_PATH: Record<string, ModelFamily[]> = {
  "/v1/chat/completions": ["gpt", "kimi", "glm", "minimax"],
  "/v1/responses": ["gpt"],
  "/v1/messages": ["claude"],
};

/**
 * Get the model name from request body
 */
function getModelFromBody(body: unknown): string | null {
  if (body && typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b.model === "string" && b.model.length > 0) {
      return b.model;
    }
  }
  return null;
}

/**
 * Protocol Guard Middleware
 * Validates model matches the endpoint protocol
 */
export async function protocolGuardMiddleware(
  c: Context,
  next: Next
): Promise<void> {
  const path = c.req.path;
  const allowedFamilies = ALLOWED_FAMILIES_PER_PATH[path];

  // Skip if path not in our guard list
  if (!allowedFamilies) {
    await next();
    return;
  }

  // Get model from body (parse if not already done)
  let body = c.get("parsedBody");
  if (!body) {
    try {
      body = await c.req.json();
      c.set("parsedBody", body);
    } catch {
      // Body not JSON, will be handled by route validation
    }
  }

  const model = getModelFromBody(body);
  if (!model) {
    // Let route handle missing model
    await next();
    return;
  }

  const modelFamily = getModelFamily(model);

  if (!modelFamily) {
    const error = errorForProtocol(
      path,
      400,
      "model_not_supported",
      `Unknown model: ${model}`
    );
    c.status(400);
    c.json(error);
    return;
  }

  // Check if model family is allowed for this path
  if (!allowedFamilies.includes(modelFamily)) {
    let errorMessage: string;

    if (path === "/v1/chat/completions" || path === "/v1/responses") {
      if (modelFamily === "claude") {
        errorMessage = "Claude models are only available via POST /v1/messages";
      } else {
        errorMessage = `Model ${model} is not supported on this endpoint`;
      }
    } else if (path === "/v1/messages") {
      errorMessage = "Non-Claude models are only available via POST /v1/chat/completions";
    } else {
      errorMessage = `Model ${model} is not supported on this endpoint`;
    }

    const error = errorForProtocol(
      path,
      400,
      "model_not_supported",
      errorMessage
    );
    c.status(400);
    c.json(error);
    return;
  }

  // Set model in context for downstream use
  c.set("model", model);
  c.set("modelFamily", modelFamily);

  await next();
}
