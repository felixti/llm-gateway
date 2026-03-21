/**
 * OpenAI Responses API Proxy
 * Transforms Responses API format to Chat Completions and back
 * Used for Codex CLI and other Responses API clients
 */

import { Hono } from "hono";
import type { DeploymentConfig } from "../config/deployments";
import { reconcileUsage } from "../services/quota.service";
import type { TokenUsage } from "../services/pricing.service";
import { errorForProtocol } from "../utils/errors";
import { extractOpenAIUsage } from "../utils/streaming";
import { AzureAuthManager } from "../services/azure-auth";
import { withRetry } from "../services/retry";
import { isRequestAllowed, recordSuccess, recordFailure } from "../services/circuit-breaker";

const responsesRoutes = new Hono();

// Export for testing
export { responsesRoutes as responsesProxy };

// Responses API built-in tool types that need transformation
const BUILTIN_TOOL_TYPES = ["file_search", "file_read", "shell_exec"];

// =============================================================================
// Request Transformation (Responses API → Chat Completions)
// =============================================================================

interface ResponsesInputItem {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface ResponsesRequest {
  model: string;
  input: string | string[] | ResponsesInputItem[];
  tools?: Array<{
    type: string;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  reasoning?: {
    effort: "high" | "medium" | "low";
  };
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

/**
 * Transform Responses API input to Chat Completions messages
 */
function transformInputToMessages(input: string | string[] | ResponsesInputItem[]): Array<{
  role: string;
  content: string;
}> {
  const messages: Array<{ role: string; content: string }> = [];

  if (typeof input === "string") {
    // Single string input → user message
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    // Array of strings or objects
    for (const item of input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (typeof item === "object") {
        const msg = item as ResponsesInputItem;
        if (msg.role === "system") {
          messages.push({ role: "system", content: String(msg.content) });
        } else if (msg.role === "user" || msg.role === "assistant") {
          const content = typeof msg.content === "string" 
            ? msg.content 
            : (msg.content as Array<{type: string; text?: string}>).map(c => c.text || "").join("\n");
          messages.push({ role: msg.role, content });
        }
      }
    }
  }

  return messages;
}

/**
 * Transform Responses API tools to function_calling format
 */
function transformTools(tools?: ResponsesRequest["tools"]): Array<{
  type: string;
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}> | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools
    .filter(tool => !BUILTIN_TOOL_TYPES.includes(tool.type))
    .map(tool => ({
      type: "function",
      function: {
        name: tool.name || `${tool.type}_tool`,
        description: tool.description || "",
        parameters: tool.parameters || { type: "object", properties: {} },
      },
    }));
}

/**
 * Map reasoning effort to Azure parameters
 */
function mapReasoningEffort(effort?: string): Record<string, unknown> {
  if (!effort) return {};

  // GPT-5.3-Codex supports reasoning effort parameter
  return {
    reasoning: {
      effort,
    },
  };
}

/**
 * Build Chat Completions request body from Responses API request
 */
function buildChatCompletionsBody(request: ResponsesRequest): Record<string, unknown> {
  const messages = transformInputToMessages(request.input);
  const tools = transformTools(request.tools);
  const reasoning = mapReasoningEffort(request.reasoning?.effort);

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: request.stream ?? false,
    ...reasoning,
  };

  if (request.max_completion_tokens) {
    body.max_completion_tokens = request.max_completion_tokens;
  } else if (request.max_tokens) {
    body.max_completion_tokens = request.max_tokens;
  }

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  return body;
}

// =============================================================================
// Response Transformation (Chat Completions → Responses API)
// =============================================================================

interface ChatCompletionChoice {
  index: number;
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
  finish_reason: string;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ResponsesOutputItem {
  id: string;
  type: string;
  status: string;
  role: string;
  content: Array<{
    type: string;
    text?: string;
    name?: string;
    input?: string;
  }>;
}

/**
 * Transform Chat Completions response to Responses API format
 */
function transformToResponsesFormat(
  response: ChatCompletionResponse,
  _requestId: string
): Record<string, unknown> {
  const outputItems: ResponsesOutputItem[] = [];

  for (const choice of response.choices) {
    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
      // Handle tool call responses
      for (const toolCall of choice.message.tool_calls) {
        outputItems.push({
          id: toolCall.id,
          type: "function",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "tool_input",
              name: toolCall.function.name,
              input: toolCall.function.arguments,
            },
          ],
        });
      }
    } else {
      // Regular text response
      outputItems.push({
        id: `msg_${choice.index}`,
        type: "message",
        status: "completed",
        role: choice.message.role,
        content: [
          {
            type: "output_text",
            text: choice.message.content,
          },
        ],
      });
    }
  }

  return {
    id: response.id,
    object: "response",
    status: "completed",
    model: response.model,
    created: response.created,
    output: outputItems,
    ...(response.usage && {
      usage: {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      },
    }),
  };
}

// =============================================================================
// Proxy Implementation
// =============================================================================

/**
 * Build upstream URL for Azure OpenAI
 */
function buildUpstreamUrl(deployment: DeploymentConfig): string {
  const { endpoint, name, apiVersion } = deployment;
  return `${endpoint}/openai/deployments/${name}/chat/completions?api-version=${apiVersion}`;
}

/**
 * Proxy non-streaming Responses API request
 */
async function proxyNonStreaming(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  reservationId: string
): Promise<Response> {
  const response = await withRetry(() =>
    fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );

  if (!response.ok) {
    recordFailure(deployment.name);
    const errorBody = await response.text();
    const error = errorForProtocol(
      "/v1/responses",
      response.status,
      "bad_gateway",
      `Azure OpenAI error: ${response.status} ${errorBody}`
    );
    return new Response(JSON.stringify(error), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  recordSuccess(deployment.name);

  // Get Chat Completions response
  const chatResponse = await response.json() as ChatCompletionResponse;

  // Extract usage for quota reconciliation
  const usage: TokenUsage | undefined = chatResponse.usage ? {
    prompt_tokens: chatResponse.usage.prompt_tokens,
    completion_tokens: chatResponse.usage.completion_tokens,
    thinking_tokens: undefined,
    cache_creation_input_tokens: undefined,
    cache_read_input_tokens: undefined,
  } : undefined;

  if (usage && reservationId) {
    await reconcileUsage(reservationId, usage, deployment.azureModelName);
  }

  // Transform to Responses API format
  const responsesResponse = transformToResponsesFormat(chatResponse, "");

  return new Response(JSON.stringify(responsesResponse), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Proxy streaming Responses API request
 */
async function proxyStreaming(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  reservationId: string,
  requestId: string
): Promise<Response> {
  const response = await withRetry(() =>
    fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
        Accept: "text/event-stream",
        "x-ms-client-request-id": requestId,
      },
      body: JSON.stringify({ ...body, stream: true }),
    })
  );

  if (!response.ok) {
    recordFailure(deployment.name);
    const errorBody = await response.text();
    const error = errorForProtocol(
      "/v1/responses",
      response.status,
      "bad_gateway",
      `Azure OpenAI error: ${response.status} ${errorBody}`
    );
    return new Response(JSON.stringify(error), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  recordSuccess(deployment.name);

  if (!response.body) {
    return new Response("Internal Server Error: No response body", { status: 500 });
  }

  let usageExtracted = false;

  // Create streaming response transformer
  const stream = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        // Pass through all chunks - transform format later if needed
        controller.enqueue(chunk);

        // Extract usage
        if (!usageExtracted && reservationId) {
          const text = new TextDecoder().decode(chunk);
          const usage = extractOpenAIUsage(text);
          if (usage) {
            usageExtracted = true;
            reconcileUsage(reservationId, usage, deployment.azureModelName).catch(
              (err) => console.error("Quota reconciliation error:", err)
            );
          }
        }
      },
      flush(controller) {
        controller.terminate();
      },
    })
  );

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Request-Id": requestId,
    },
  });
}

/**
 * Main POST handler for /v1/responses
 */
responsesRoutes.post("/", async (c) => {
  const deployment = c.get("deployment");
  const requestId = c.get("requestId");
  const reservationId = c.get("reservationId");

  // Check circuit breaker
  if (!isRequestAllowed(deployment.name)) {
    const error = errorForProtocol(
      "/v1/responses",
      503,
      "service_unavailable",
      "Service temporarily unavailable, please retry"
    );
    return c.json(error, 503);
  }

  // Get auth headers
  const authManager = new AzureAuthManager();
  const authHeaders = await authManager.getAuthHeaders(deployment.name);

  // Parse request body
  const request = await c.req.json<ResponsesRequest>();

  // Build Chat Completions request
  const chatBody = buildChatCompletionsBody(request);

  // Build upstream URL
  const upstreamUrl = buildUpstreamUrl(deployment);

  // Determine if streaming
  const isStreaming = request.stream === true;

  if (isStreaming) {
    return proxyStreaming(upstreamUrl, authHeaders, chatBody, deployment, reservationId, requestId);
  }

  return proxyNonStreaming(upstreamUrl, authHeaders, chatBody, deployment, reservationId);
});

export { responsesRoutes };
