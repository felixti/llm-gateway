# LLM Gateway - Implementation Playbook

**Companion to:** LLM Gateway PRD v1.2  
**Purpose:** Tactical implementation guide with code patterns and best practices

---

## Table of Contents

1. [Project Setup](#1-project-setup)
2. [Core Services Implementation](#2-core-services-plementation)
3. [Protocol Adapters](#3-protocol-adapters)
4. [Quota Management](#4-quota-management)
5. [Azure Integration](#5-azure-integration)
6. [Observability Setup](#6-observability-setup)
7. [Testing Strategy](#7-testing-strategy)
8. [Deployment Guide](#8-deployment-guide)

---

## 1. Project Setup

### 1.1 Initialize Project

```bash
# Create project
mkdir llm-gateway && cd llm-gateway
bun init -y

# Install dependencies
bun add hono @hono/zod-validator zod decimal.js ioredis
bun add -d @types/bun typescript

# OpenTelemetry
bun add @opentelemetry/api @opentelemetry/sdk-node
bun add @opentelemetry/exporter-trace-otlp-grpc
bun add @opentelemetry/instrumentation-http
bun add @opentelemetry/resources @opentelemetry/semantic-conventions

# Utilities
bun add tiktoken jose uuid
bun add -d @types/uuid
```

### 1.2 Project Structure

```
llm-gateway/
├── src/
│   ├── index.ts                 # Entry point
│   ├── config/
│   │   ├── index.ts             # Environment config
│   │   ├── pricing.json         # Cost configuration
│   │   └── deployments.ts       # Azure deployment mapping
│   ├── middleware/
│   │   ├── auth.ts              # PAT validation with revocation
│   │   ├── quota.ts             # Quota check middleware
│   │   ├── logging.ts           # Request logging
│   │   └── error.ts             # Error handling
│   ├── services/
│   │   ├── azure-auth.ts        # Azure auth manager (Entra ID + API Key)
│   │   ├── quota-service.ts     # Quota calculation & enforcement
│   │   ├── pricing-service.ts   # Cost calculation
│   │   ├── azure-client.ts      # HTTP client for Azure
│   │   └── circuit-breaker.ts   # Resilience patterns
│   ├── adapters/
│   │   ├── canonical.ts         # Internal request format
│   │   ├── openai-chat.ts       # Chat Completions adapter
│   │   ├── openai-responses.ts  # Responses API adapter
│   │   └── anthropic.ts         # Messages API adapter (with thinking)
│   ├── routes/
│   │   ├── chat.ts              # /v1/chat/completions
│   │   ├── responses.ts         # /v1/responses
│   │   ├── messages.ts          # /v1/messages
│   │   ├── models.ts            # /v1/models
│   │   ├── health.ts            # /health, /quota
│   │   └── admin.ts             # /admin/pat/revoke
│   ├── utils/
│   │   ├── tokens.ts            # Token estimation
│   │   ├── streams.ts           # SSE parsing & transformation
│   │   └── errors.ts            # Error factories
│   └── types/
│       ├── index.ts             # Shared types
│       ├── openai.ts            # OpenAI type definitions
│       └── anthropic.ts         # Anthropic type definitions
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── docker-compose.yml           # Local development stack
├── Dockerfile
└── tsconfig.json
```

### 1.3 TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["bun-types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 2. Core Services Implementation

### 2.1 Configuration Management

```typescript
// src/config/index.ts
import { z } from "zod";

const configSchema = z.object({
  port: z.number().default(3000),
  env: z.enum(["development", "production", "test"]).default("development"),

  // Azure (flexible auth per deployment)
  azure: z.object({
    // Entra ID credentials (optional - used if deployment authType is 'entra-id')
    tenantId: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    // API Keys (optional - used if deployment authType is 'api-key')
    openaiApiKey: z.string().optional(),
    inferenceApiKey: z.string().optional(),
    // Endpoints
    openaiEndpoint: z.string().url(),
    inferenceEndpoint: z.string().url(),
  }),

  // Redis
  redis: z.object({
    url: z.string().default("redis://localhost:6379"),
  }),

  // Database
  database: z.object({
    url: z.string(),
  }),

  // Observability
  otel: z.object({
    endpoint: z.string().optional(),
    serviceName: z.string().default("llm-gateway"),
  }),
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse({
  port: parseInt(process.env.PORT || "3000"),
  env: process.env.NODE_ENV,
  azure: {
    tenantId: process.env.AZURE_TENANT_ID,
    clientId: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    openaiApiKey: process.env.AZURE_OPENAI_API_KEY,
    inferenceApiKey: process.env.AZURE_AI_INFERENCE_API_KEY,
    openaiEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    inferenceEndpoint: process.env.AZURE_AI_INFERENCE_ENDPOINT,
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  otel: {
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: process.env.OTEL_SERVICE_NAME,
  },
});
```

### 2.2 Azure Authentication Manager (Entra ID + API Key)

```typescript
// src/services/azure-auth.ts
import { jwtDecode } from "jwt-decode";
import { config } from "../config";

export type AuthType = "entra-id" | "api-key";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export interface AzureAuthConfig {
  type: AuthType;
  // For Entra ID
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  // For API Key
  apiKey?: string;
  keyHeader?: string; // 'api-key' or 'Authorization'
}

export class AzureAuthManager {
  private tokenCache: Map<string, CachedToken> = new Map();

  async getAuthHeaders(
    authConfig: AzureAuthConfig,
  ): Promise<Record<string, string>> {
    switch (authConfig.type) {
      case "entra-id":
        return this.getEntraIDHeaders(authConfig);
      case "api-key":
        return this.getApiKeyHeaders(authConfig);
      default:
        throw new Error(`Unknown auth type: ${authConfig.type}`);
    }
  }

  private async getEntraIDHeaders(
    config: AzureAuthConfig,
  ): Promise<Record<string, string>> {
    const cacheKey = `${config.tenantId}:${config.clientId}`;
    const cached = this.tokenCache.get(cacheKey);
    const now = Math.floor(Date.now() / 1000);

    // Refresh 5 minutes before expiry
    if (cached && cached.expiresAt > now + 300) {
      return { Authorization: `Bearer ${cached.accessToken}` };
    }

    const token = await this.acquireEntraToken(config);
    const decoded = jwtDecode<{ exp: number }>(token);

    this.tokenCache.set(cacheKey, {
      accessToken: token,
      expiresAt: decoded.exp,
    });

    return { Authorization: `Bearer ${token}` };
  }

  private async acquireEntraToken(config: AzureAuthConfig): Promise<string> {
    const url = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId!,
      client_secret: config.clientSecret!,
      scope: config.scope || "https://cognitiveservices.azure.com/.default",
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Entra ID auth failed: ${error}`);
    }

    const data = await response.json();
    return data.access_token;
  }

  private getApiKeyHeaders(config: AzureAuthConfig): Record<string, string> {
    const headerName = config.keyHeader || "api-key";

    if (headerName === "Authorization") {
      return { Authorization: `Bearer ${config.apiKey}` };
    }

    return { [headerName]: config.apiKey! };
  }

  // Clear cache (useful for testing or key rotation)
  clearCache(): void {
    this.tokenCache.clear();
  }
}

export const azureAuthManager = new AzureAuthManager();
```

### 2.3 PAT Authentication with Revocation

```typescript
// src/middleware/auth.ts
import { createMiddleware } from "hono/factory";
import { createHmac } from "crypto";
import { Redis } from "ioredis";

interface PATPayload {
  userId: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string; // JWT ID for revocation tracking
}

const SECRET_KEY = process.env.PAT_SECRET!; // HS256 key

export class PATService {
  constructor(private redis: Redis) {}

  async isRevoked(jti: string): Promise<boolean> {
    const revoked = await this.redis.get(`blocklist:pat:${jti}`);
    return revoked !== null;
  }

  async revoke(jti: string, expiryTimestamp: number): Promise<void> {
    const ttl = expiryTimestamp - Math.floor(Date.now() / 1000);
    if (ttl > 0) {
      await this.redis.setex(`blocklist:pat:${jti}`, ttl, "1");
    }
  }
}

export const authMiddleware = (patService: PATService) =>
  createMiddleware(async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(
        {
          error: {
            type: "authentication_error",
            message: "Missing or invalid Authorization header",
          },
        },
        401,
      );
    }

    const token = authHeader.slice(7);

    try {
      const payload = verifyPAT(token);

      // Check revocation
      const isRevoked = await patService.isRevoked(payload.jti);
      if (isRevoked) {
        return c.json(
          {
            error: {
              type: "authentication_error",
              message: "Token has been revoked",
            },
          },
          401,
        );
      }

      if (payload.exp < Date.now() / 1000) {
        throw new Error("Token expired");
      }

      c.set("userId", payload.userId);
      c.set("scope", payload.scope);
      c.set("jti", payload.jti);
      await next();
    } catch (error) {
      return c.json(
        {
          error: {
            type: "authentication_error",
            message: "Invalid API key",
          },
        },
        401,
      );
    }
  });

function verifyPAT(token: string): PATPayload {
  const [header, payload, signature] = token.split(".");

  if (!header || !payload || !signature) {
    throw new Error("Invalid token format");
  }

  // Verify signature
  const expectedSig = createHmac("sha256", SECRET_KEY)
    .update(`${header}.${payload}`)
    .digest("base64url");

  if (signature !== expectedSig) {
    throw new Error("Invalid signature");
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString());
}

// PAT Generation (for admin use)
export function generatePAT(
  userId: string,
  scope: string = "all",
  expiresInDays: number = 90,
): string {
  const jti = crypto.randomUUID();
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "PAT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      scope,
      jti,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiresInDays * 86400,
    }),
  ).toString("base64url");

  const signature = createHmac("sha256", SECRET_KEY)
    .update(`${header}.${payload}`)
    .digest("base64url");

  return `lg_${userId}_${header}.${payload}.${signature}`;
}
```

---

## 3. Protocol Adapters

### 3.1 Canonical Request Format

```typescript
// src/adapters/canonical.ts
export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: "text" | "image_url" | "thinking";
  text?: string;
  image_url?: { url: string; detail?: "low" | "high" | "auto" };
  thinking?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CanonicalTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  tool_choice?:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } };
  temperature?: number;
  max_completion_tokens?: number; // Modern API uses max_completion_tokens
  max_tokens?: number; // Legacy support with deprecation warning
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  response_format?: { type: "text" | "json_object" };
  // Thinking mode (Anthropic)
  thinking?: {
    type: "enabled" | "disabled";
    budget_tokens: number;
  };
  // Protocol hints
  _protocol: "openai-chat" | "openai-responses" | "anthropic";
  _originalBody: unknown;
}
```

### 3.2 OpenAI Chat Completions Adapter

```typescript
// src/adapters/openai-chat.ts
import type { CanonicalRequest, CanonicalMessage } from "./canonical";

export interface OpenAIChatRequest {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content:
      | string
      | Array<
          | { type: "text"; text: string }
          | { type: "image_url"; image_url: { url: string } }
        >;
    name?: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } };
  temperature?: number;
  max_completion_tokens?: number; // Modern API
  max_tokens?: number; // Legacy
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  response_format?: { type: "text" | "json_object" };
}

export function toCanonical(body: OpenAIChatRequest): CanonicalRequest {
  // Warn if using deprecated max_tokens
  if (body.max_tokens && !body.max_completion_tokens) {
    console.warn("Deprecated: max_tokens is replaced by max_completion_tokens");
  }

  return {
    model: body.model,
    messages: body.messages.map((m) => ({
      role: m.role,
      content: m.content,
      name: m.name,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
    })),
    tools: body.tools,
    tool_choice: body.tool_choice,
    temperature: body.temperature,
    max_completion_tokens: body.max_completion_tokens || body.max_tokens,
    top_p: body.top_p,
    frequency_penalty: body.frequency_penalty,
    presence_penalty: body.presence_penalty,
    stream: body.stream,
    response_format: body.response_format,
    _protocol: "openai-chat",
    _originalBody: body,
  };
}

export function fromCanonical(request: CanonicalRequest): OpenAIChatRequest {
  return {
    model: request.model,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content as string,
      name: m.name,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
    })),
    tools: request.tools,
    tool_choice: request.tool_choice,
    temperature: request.temperature,
    max_completion_tokens: request.max_completion_tokens,
    top_p: request.top_p,
    frequency_penalty: request.frequency_penalty,
    presence_penalty: request.presence_penalty,
    stream: request.stream,
    response_format: request.response_format,
  };
}
```

### 3.3 Anthropic Messages Adapter with Thinking Mode

```typescript
// src/adapters/anthropic.ts
import type {
  CanonicalRequest,
  CanonicalMessage,
  CanonicalTool,
} from "./canonical";

export interface AnthropicRequest {
  model: string;
  messages: Array<{
    role: "user" | "assistant";
    content:
      | string
      | Array<
          | { type: "text"; text: string }
          | { type: "thinking"; thinking: string }
        >;
  }>;
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  thinking?: {
    type: "enabled";
    budget_tokens: number;
  };
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface AnthropicContentBlock {
  type: "text" | "thinking" | "tool_use";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export function toCanonical(body: AnthropicRequest): CanonicalRequest {
  // Extract system from separate field
  const systemMessages: CanonicalMessage[] = [];
  if (body.system) {
    const systemContent =
      typeof body.system === "string"
        ? body.system
        : body.system.map((s) => s.text).join("\n");
    systemMessages.push({ role: "system", content: systemContent });
  }

  // Process messages with thinking blocks
  const processedMessages: CanonicalMessage[] = [];
  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      processedMessages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      });
    } else {
      // Handle content blocks (text + thinking)
      for (const block of msg.content) {
        if (block.type === "text") {
          processedMessages.push({
            role: msg.role === "user" ? "user" : "assistant",
            content: block.text!,
          });
        } else if (block.type === "thinking") {
          processedMessages.push({
            role: "assistant",
            content: [{ type: "thinking", thinking: block.thinking! }],
          });
        }
      }
    }
  }

  return {
    model: body.model,
    messages: [...systemMessages, ...processedMessages],
    tools: body.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    })),
    tool_choice:
      body.tool_choice?.type === "tool"
        ? {
            type: "function" as const,
            function: { name: body.tool_choice.name! },
          }
        : body.tool_choice?.type === "any"
          ? "auto"
          : body.tool_choice?.type,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    top_p: body.top_p,
    stream: body.stream,
    thinking: body.thinking,
    _protocol: "anthropic",
    _originalBody: body,
  };
}

export function fromCanonical(request: CanonicalRequest): AnthropicRequest {
  // Separate system messages
  const systemMessages = request.messages.filter((m) => m.role === "system");
  const otherMessages = request.messages.filter((m) => m.role !== "system");

  // Process messages for Anthropic format
  const anthropicMessages: AnthropicRequest["messages"] = [];
  for (const msg of otherMessages) {
    if (Array.isArray(msg.content)) {
      // Content parts (thinking blocks)
      const content: AnthropicContentBlock[] = [];
      for (const part of msg.content) {
        if (part.type === "thinking") {
          content.push({ type: "thinking", thinking: part.thinking! });
        } else {
          content.push({ type: "text", text: part.text! });
        }
      }
      anthropicMessages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content,
      });
    } else {
      anthropicMessages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content as string,
      });
    }
  }

  return {
    model: request.model,
    system:
      systemMessages.length > 0
        ? systemMessages.map((m) => ({
            type: "text" as const,
            text: m.content as string,
          }))
        : undefined,
    messages: anthropicMessages,
    max_tokens: request.max_tokens || 4096,
    thinking: request.thinking,
    tools: request.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    })),
    tool_choice:
      request.tool_choice === "auto"
        ? { type: "auto" }
        : request.tool_choice === "none"
          ? undefined
          : request.tool_choice?.type === "function"
            ? { type: "tool", name: request.tool_choice.function.name }
            : { type: "auto" },
    temperature: request.temperature,
    top_p: request.top_p,
    stream: request.stream,
  };
}
```

### 3.4 Protocol Router Middleware

```typescript
// src/middleware/protocol-router.ts
import { createMiddleware } from "hono/factory";
import { toCanonical as openaiToCanonical } from "../adapters/openai-chat";
import { toCanonical as anthropicToCanonical } from "../adapters/anthropic";

export const protocolRouter = createMiddleware(async (c, next) => {
  const path = c.req.path;
  const body = await c.req.json();

  let canonical: CanonicalRequest;

  if (path === "/v1/chat/completions") {
    canonical = openaiToCanonical(body);
  } else if (path === "/v1/messages") {
    canonical = anthropicToCanonical(body);
  } else if (path === "/v1/responses") {
    // Handle Responses API (Codex)
    canonical = responsesToCanonical(body);
  } else {
    return c.json({ error: "Unknown endpoint" }, 404);
  }

  c.set("canonical", canonical);
  await next();
});
```

---

## 4. Quota Management

### 4.1 Pricing Service with Thinking Tokens

```typescript
// src/services/pricing-service.ts
import { Decimal } from "decimal.js";
import pricingConfig from "../config/pricing.json";

export interface ModelPricing {
  deploymentPattern: string;
  inputPerMillion: Decimal;
  outputPerMillion: Decimal;
  thinkingPerMillion?: Decimal; // NEW: Thinking tokens pricing
  cacheWritePerMillion?: Decimal;
  cacheReadPerMillion?: Decimal;
}

export class PricingService {
  private pricing: Map<string, ModelPricing> = new Map();

  constructor() {
    this.loadPricing();
  }

  private loadPricing() {
    for (const [key, config] of Object.entries(pricingConfig.models)) {
      this.pricing.set(key, {
        deploymentPattern: config.deployment_pattern,
        inputPerMillion: new Decimal(config.input_per_million),
        outputPerMillion: new Decimal(config.output_per_million),
        thinkingPerMillion: config.thinking_tokens_per_million
          ? new Decimal(config.thinking_tokens_per_million)
          : undefined,
        cacheWritePerMillion: config.cache_write_per_million
          ? new Decimal(config.cache_write_per_million)
          : undefined,
        cacheReadPerMillion: config.cache_read_per_million
          ? new Decimal(config.cache_read_per_million)
          : undefined,
      });
    }
  }

  getPricingForDeployment(deploymentName: string): ModelPricing {
    for (const pricing of this.pricing.values()) {
      const regex = new RegExp(
        pricing.deploymentPattern.replace("*", ".*"),
        "i",
      );
      if (regex.test(deploymentName)) {
        return pricing;
      }
    }
    throw new Error(`No pricing found for deployment: ${deploymentName}`);
  }

  calculateCost(
    deploymentName: string,
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      thinking_tokens?: number; // NEW
    },
  ): Decimal {
    const pricing = this.getPricingForDeployment(deploymentName);

    const inputCost = new Decimal(usage.prompt_tokens)
      .div(1000000)
      .times(pricing.inputPerMillion);

    const outputCost = new Decimal(usage.completion_tokens)
      .div(1000000)
      .times(pricing.outputPerMillion);

    // Calculate thinking tokens cost
    let thinkingCost = new Decimal(0);
    if (usage.thinking_tokens && pricing.thinkingPerMillion) {
      thinkingCost = new Decimal(usage.thinking_tokens)
        .div(1000000)
        .times(pricing.thinkingPerMillion);
    }

    return inputCost.plus(outputCost).plus(thinkingCost);
  }
}

export const pricingService = new PricingService();
```

### 4.2 Quota Service with Redis

```typescript
// src/services/quota-service.ts
import { Redis } from "ioredis";
import { Decimal } from "decimal.js";
import { pricingService } from "./pricing-service";

const RESERVE_MULTIPLIER = 1.2;
const RESERVATION_TTL = 300; // 5 minutes

export interface QuotaCheck {
  allowed: boolean;
  reservationId?: string;
  estimatedCost: Decimal;
  reason?: string;
}

export class QuotaService {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async checkAndReserve(
    userId: string,
    deploymentName: string,
    estimatedTokens: { input: number; output: number; thinking?: number },
    thinkingEnabled: boolean = false,
  ): Promise<QuotaCheck> {
    // Add 20% buffer for thinking if enabled
    const thinkingBuffer = thinkingEnabled ? 0.2 : 0;
    const estimatedThinking =
      estimatedTokens.thinking ||
      (thinkingEnabled ? Math.floor(estimatedTokens.output * 0.3) : 0);

    const estimatedCost = pricingService
      .calculateCost(deploymentName, {
        prompt_tokens: estimatedTokens.input,
        completion_tokens: estimatedTokens.output,
        thinking_tokens: estimatedThinking,
      })
      .times(RESERVE_MULTIPLIER + thinkingBuffer);

    const monthKey = new Date().toISOString().slice(0, 7);
    const quotaKey = `quota:${userId}:${monthKey}`;
    const reservedKey = `reserved:${userId}:${monthKey}`;

    // Atomic Lua script
    const script = `
      local budget = tonumber(redis.call('HGET', KEYS[1], 'budget') or '0')
      local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
      local reserved = tonumber(redis.call('GET', KEYS[2]) or '0')
      local estimate = tonumber(ARGV[1])
      
      if (spent + reserved + estimate) > budget then
        return {0, "Quota exceeded"}
      end
      
      local reservation_id = ARGV[2]
      redis.call('INCRBYFLOAT', KEYS[2], estimate)
      redis.call('EXPIRE', KEYS[2], ARGV[3])
      redis.call('SET', 'reservation:' .. reservation_id, estimate, 'EX', ARGV[3])
      
      return {1, reservation_id, tostring(estimate)}
    `;

    const reservationId = crypto.randomUUID();
    const result = (await this.redis.eval(
      script,
      2,
      quotaKey,
      reservedKey,
      estimatedCost.toString(),
      reservationId,
      RESERVATION_TTL.toString(),
    )) as [number, string, string];

    if (result[0] === 0) {
      return { allowed: false, reason: result[1] };
    }

    return {
      allowed: true,
      reservationId,
      estimatedCost: new Decimal(result[2]),
    };
  }

  async reconcileUsage(
    userId: string,
    reservationId: string,
    deploymentName: string,
    actualUsage: {
      prompt_tokens: number;
      completion_tokens: number;
      thinking_tokens?: number;
    },
  ): Promise<void> {
    const monthKey = new Date().toISOString().slice(0, 7);
    const quotaKey = `quota:${userId}:${monthKey}`;
    const reservedKey = `reserved:${userId}:${monthKey}`;

    const actualCost = pricingService.calculateCost(
      deploymentName,
      actualUsage,
    );

    // Get reserved amount
    const reservedAmount = await this.redis.get(`reservation:${reservationId}`);
    if (!reservedAmount) return; // Already cleaned up

    const pipeline = this.redis.pipeline();

    // Add actual cost to spent
    pipeline.hincrbyfloat(quotaKey, "spent", actualCost.toString());

    // Remove reservation tracking
    pipeline.del(`reservation:${reservationId}`);

    // Decrease reserved amount
    pipeline.incrbyfloat(reservedKey, `-${reservedAmount}`);

    await pipeline.exec();
  }

  async releaseReservation(
    userId: string,
    reservationId: string,
  ): Promise<void> {
    const monthKey = new Date().toISOString().slice(0, 7);
    const reservedKey = `reserved:${userId}:${monthKey}`;

    const amount = await this.redis.get(`reservation:${reservationId}`);
    if (amount) {
      await this.redis.incrbyfloat(reservedKey, `-${amount}`);
      await this.redis.del(`reservation:${reservationId}`);
    }
  }

  async getQuotaStatus(userId: string) {
    const monthKey = new Date().toISOString().slice(0, 7);
    const quotaKey = `quota:${userId}:${monthKey}`;
    const reservedKey = `reserved:${userId}:${monthKey}`;

    const [quotaData, reserved] = await Promise.all([
      this.redis.hgetall(quotaKey),
      this.redis.get(reservedKey),
    ]);

    const budget = new Decimal(quotaData.budget || "0");
    const spent = new Decimal(quotaData.spent || "0");
    const reservedAmt = new Decimal(reserved || "0");

    return {
      budget: budget.toNumber(),
      spent: spent.toNumber(),
      reserved: reservedAmt.toNumber(),
      remaining: budget.minus(spent).minus(reservedAmt).toNumber(),
    };
  }
}
```

### 4.3 Quota Middleware

```typescript
// src/middleware/quota.ts
import { createMiddleware } from "hono/factory";
import { estimateTokens } from "../utils/tokens";

export const quotaMiddleware = (quotaService: QuotaService) =>
  createMiddleware(async (c, next) => {
    const userId = c.get("userId");
    const deployment = c.get("deployment");
    const request = c.get("canonical");

    // Estimate tokens
    const estimatedInput = estimateTokens(request.messages);
    const estimatedOutput =
      request.max_completion_tokens || request.max_tokens || 4096;
    const thinkingEnabled = request.thinking?.type === "enabled";

    const check = await quotaService.checkAndReserve(
      userId,
      deployment.name,
      { input: estimatedInput, output: estimatedOutput },
      thinkingEnabled,
    );

    if (!check.allowed) {
      return c.json(
        {
          error: {
            type: "insufficient_quota",
            message: "Monthly budget exceeded",
            code: "quota_exceeded",
          },
        },
        429,
      );
    }

    c.set("reservationId", check.reservationId);
    c.set("estimatedCost", check.estimatedCost);

    try {
      await next();
    } catch (error) {
      await quotaService.releaseReservation(userId, check.reservationId);
      throw error;
    }
  });
```

---

## 5. Azure Integration

### 5.1 Deployment Configuration

```typescript
// src/config/deployments.ts
import { AzureAuthConfig } from "../services/azure-auth";

export interface AzureDeployment {
  name: string; // Internal reference (e.g., "gpt-5.4-global")
  modelName: string; // Azure model name (e.g., "gpt-5.4", "FW-Kimi-K2.5")
  endpoint: string; // Azure AI Inference endpoint
  auth: AzureAuthConfig; // Auth configuration
  apiVersion: string; // API version
}

// All models use Azure AI Inference with OpenAI-compatible Chat Completions API
export const deployments: AzureDeployment[] = [
  // Azure OpenAI (GPT models)
  {
    name: "gpt-5.4-global",
    modelName: "gpt-5.4",
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    auth: {
      type: process.env.AZURE_OPENAI_API_KEY ? "api-key" : "entra-id",
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
    apiVersion: "2025-01-01-preview",
  },
  {
    name: "gpt-5.3-codex",
    modelName: "gpt-5.3-codex",
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    auth: {
      type: process.env.AZURE_OPENAI_API_KEY ? "api-key" : "entra-id",
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
    apiVersion: "2025-01-01-preview",
  },
  // Azure AI Inference (Claude models)
  {
    name: "claude-opus-4-6",
    modelName: "claude-opus-4-6",
    endpoint: process.env.AZURE_AI_INFERENCE_ENDPOINT!,
    auth: {
      type: process.env.AZURE_AI_INFERENCE_API_KEY ? "api-key" : "entra-id",
      apiKey: process.env.AZURE_AI_INFERENCE_API_KEY,
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
    apiVersion: "2024-12-01",
  },
  {
    name: "claude-sonnet-4-6",
    modelName: "claude-sonnet-4-6",
    endpoint: process.env.AZURE_AI_INFERENCE_ENDPOINT!,
    auth: {
      type: process.env.AZURE_AI_INFERENCE_API_KEY ? "api-key" : "entra-id",
      apiKey: process.env.AZURE_AI_INFERENCE_API_KEY,
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
    apiVersion: "2024-12-01",
  },
  {
    name: "claude-haiku-4-5",
    modelName: "claude-haiku-4-5",
    endpoint: process.env.AZURE_AI_INFERENCE_ENDPOINT!,
    auth: {
      type: process.env.AZURE_AI_INFERENCE_API_KEY ? "api-key" : "entra-id",
      apiKey: process.env.AZURE_AI_INFERENCE_API_KEY,
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
    apiVersion: "2024-12-01",
  },
  // Azure AI Inference (Third-party models)
  {
    name: "kimi-k2.5",
    modelName: "FW-Kimi-K2.5",
    endpoint: process.env.AZURE_AI_INFERENCE_ENDPOINT!,
    auth: {
      type: process.env.AZURE_AI_INFERENCE_API_KEY ? "api-key" : "entra-id",
      apiKey: process.env.AZURE_AI_INFERENCE_API_KEY,
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
    apiVersion: "2024-12-01",
  },
  {
    name: "glm-5",
    modelName: "FW-GLM-5",
    endpoint: process.env.AZURE_AI_INFERENCE_ENDPOINT!,
    auth: {
      type: process.env.AZURE_AI_INFERENCE_API_KEY ? "api-key" : "entra-id",
      apiKey: process.env.AZURE_AI_INFERENCE_API_KEY,
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
    apiVersion: "2024-12-01",
  },
  {
    name: "minimax-m2.5",
    modelName: "FW-MiniMax-M2.5",
    endpoint: process.env.AZURE_AI_INFERENCE_ENDPOINT!,
    auth: {
      type: process.env.AZURE_AI_INFERENCE_API_KEY ? "api-key" : "entra-id",
      apiKey: process.env.AZURE_AI_INFERENCE_API_KEY,
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
    apiVersion: "2024-12-01",
  },
];

// Model alias mapping
export const modelAliases: Record<string, string> = {
  "gpt-5.4": "gpt-5.4-global",
  "gpt-5.3-codex": "gpt-5.3-codex",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5": "claude-haiku-4-5",
  "kimi-k2.5": "kimi-k2.5",
  "glm-5": "glm-5",
  "minimax-m2.5": "minimax-m2.5",
};

export function getDeploymentByAlias(
  alias: string,
): AzureDeployment | undefined {
  const deploymentName = modelAliases[alias];
  if (!deploymentName) return undefined;
  return deployments.find((d) => d.name === deploymentName);
}
```

### 5.2 HTTP Client with Connection Pooling

```typescript
// src/services/azure-client.ts
import { Agent } from "undici";
import { azureAuthManager } from "./azure-auth";
import { AzureDeployment } from "../config/deployments";

export class AzureHttpClient {
  private agents: Map<string, Agent> = new Map();

  private getAgent(endpoint: string): Agent {
    if (!this.agents.has(endpoint)) {
      const agent = new Agent({
        connect: {
          rejectUnauthorized: true,
          requestOCSP: true,
        },
        keepAliveTimeout: 30000,
        keepAliveMaxTimeout: 60000,
        bodyTimeout: 0, // Disable for streaming
        headersTimeout: 30000,
      });
      this.agents.set(endpoint, agent);
    }
    return this.agents.get(endpoint)!;
  }

  async request(
    deployment: AzureDeployment,
    body: unknown,
    stream: boolean = false,
  ): Promise<Response> {
    const authHeaders = await azureAuthManager.getAuthHeaders(deployment.auth);
    const agent = this.getAgent(deployment.endpoint);

    // All models use OpenAI-compatible Chat Completions API
    const url = `${deployment.endpoint}/models/${deployment.modelName}/chat/completions?api-version=${deployment.apiVersion}`;

    return fetch(url, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "x-ms-client-request-id": crypto.randomUUID(),
        ...(stream && { Accept: "text/event-stream" }),
      },
      body: JSON.stringify(body),
      // @ts-ignore
      dispatcher: agent,
    });
  }
}

export const azureClient = new AzureHttpClient();
```

### 5.3 Streaming Handler with Thinking Support

```typescript
// src/utils/streams.ts
import { pricingService } from "../services/pricing-service";

export interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
}

export function createSSEParser() {
  let buffer = "";

  return new TransformStream<Uint8Array, SSEEvent>({
    transform(chunk, controller) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent: Partial<SSEEvent> = {};

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent.event = line.slice(7);
        } else if (line.startsWith("data: ")) {
          currentEvent.data = line.slice(6);
        } else if (line === "" && currentEvent.data) {
          controller.enqueue(currentEvent as SSEEvent);
          currentEvent = {};
        }
      }
    },
  });
}

export function createOpenAIStreamTransformer(
  userId: string,
  reservationId: string,
  deploymentName: string,
  quotaService: QuotaService,
) {
  let buffer = "";
  let usage: {
    prompt_tokens: number;
    completion_tokens: number;
    thinking_tokens?: number;
  } | null = null;

  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            controller.enqueue("data: [DONE]\n\n");
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) {
              usage = {
                prompt_tokens: parsed.usage.prompt_tokens,
                completion_tokens: parsed.usage.completion_tokens,
                thinking_tokens: parsed.usage.thinking_tokens,
              };
            }
            controller.enqueue(`data: ${data}\n\n`);
          } catch {
            controller.enqueue(`data: ${data}\n\n`);
          }
        }
      }
    },

    async flush() {
      if (usage) {
        await quotaService.reconcileUsage(
          userId,
          reservationId,
          deploymentName,
          usage,
        );
        const cost = pricingService.calculateCost(deploymentName, usage);
        console.log(`User ${userId} charged $${cost} for ${deploymentName}`);
      } else {
        await quotaService.releaseReservation(userId, reservationId);
      }
    },
  });
}
```

### 5.4 Circuit Breaker

```typescript
// src/services/circuit-breaker.ts
export class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failures = 0;
  private lastFailureTime = 0;

  constructor(
    private name: string,
    private failureThreshold = 5,
    private resetTimeout = 30000,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = "half-open";
      } else {
        throw new Error(`Circuit breaker open for ${this.name}`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = "open";
      console.warn(`Circuit breaker opened for ${this.name}`);
    }
  }

  getState() {
    return { name: this.name, state: this.state, failures: this.failures };
  }
}

export const circuitBreakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(deploymentName: string): CircuitBreaker {
  if (!circuitBreakers.has(deploymentName)) {
    circuitBreakers.set(deploymentName, new CircuitBreaker(deploymentName));
  }
  return circuitBreakers.get(deploymentName)!;
}
```

---

## 6. Observability Setup

### 6.1 OpenTelemetry Configuration

```typescript
// src/observability/index.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { config } from "../config";

export function initObservability() {
  if (!config.otel.endpoint) {
    console.log("OpenTelemetry disabled (no endpoint configured)");
    return;
  }

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: config.otel.endpoint,
    }),
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: config.otel.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: "1.2.0",
    }),
    instrumentations: [new HttpInstrumentation()],
  });

  sdk.start();
  console.log("OpenTelemetry initialized");

  process.on("SIGTERM", () => {
    sdk.shutdown().then(() => console.log("OTel shutdown"));
  });
}
```

### 6.2 Custom Span Attributes

```typescript
// src/observability/attributes.ts
import { trace, context } from "@opentelemetry/api";

export function setLLMSpanAttributes(attrs: {
  userId: string;
  model: string;
  deployment: string;
  tokensInput: number;
  tokensOutput: number;
  tokensThinking?: number;
  costUsd: number;
  protocol: string;
  durationMs: number;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  azureAuthType?: string;
}) {
  const span = trace.getSpan(context.active());
  if (!span) return;

  span.setAttribute("llm.user_id", attrs.userId);
  span.setAttribute("llm.model", attrs.model);
  span.setAttribute("llm.deployment", attrs.deployment);
  span.setAttribute("llm.tokens.input", attrs.tokensInput);
  span.setAttribute("llm.tokens.output", attrs.tokensOutput);
  if (attrs.tokensThinking) {
    span.setAttribute("llm.tokens.thinking", attrs.tokensThinking);
  }
  span.setAttribute("llm.cost.usd", attrs.costUsd);
  span.setAttribute("llm.protocol", attrs.protocol);
  span.setAttribute("llm.duration_ms", attrs.durationMs);
  if (attrs.thinkingEnabled !== undefined) {
    span.setAttribute("llm.thinking.enabled", attrs.thinkingEnabled);
  }
  if (attrs.thinkingBudget) {
    span.setAttribute("llm.thinking.budget_tokens", attrs.thinkingBudget);
  }
  if (attrs.azureAuthType) {
    span.setAttribute("azure.auth_type", attrs.azureAuthType);
  }
}
```

---

## 7. Testing Strategy

### 7.1 Unit Tests

```typescript
// tests/unit/pricing.test.ts
import { test, expect } from "bun:test";
import { PricingService } from "../../src/services/pricing-service";

test("calculates GPT-5.4 cost correctly", () => {
  const pricing = new PricingService();

  const cost = pricing.calculateCost("gpt-5.4-deployment", {
    prompt_tokens: 1000000,
    completion_tokens: 500000,
  });

  // $5.00 per 1M input + $15.00 per 1M output
  expect(cost.toString()).toBe("12.5");
});

test("calculates Claude Opus 4.6 cost with thinking", () => {
  const pricing = new PricingService();

  const cost = pricing.calculateCost("claude-opus-4-6", {
    prompt_tokens: 1000,
    completion_tokens: 500,
    thinking_tokens: 800,
  });

  // $15/1M input + $75/1M output + $15/1M thinking
  // = 0.015 + 0.0375 + 0.012 = 0.0645
  expect(cost.toNumber()).toBeCloseTo(0.0645, 4);
});

test("pattern matching for FW models (case insensitive)", () => {
  const pricing = new PricingService();

  const p1 = pricing.getPricingForDeployment("FW-Kimi-K2.5");
  expect(p1.inputPerMillion.toString()).toBe("2.5");

  const p2 = pricing.getPricingForDeployment("fw-glm-5");
  expect(p2.inputPerMillion.toString()).toBe("2");
});
```

### 7.2 Integration Tests

```typescript
// tests/integration/gateway.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import app from "../../src/index";

test("OpenAI chat completions endpoint with max_completion_tokens", async () => {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
      max_completion_tokens: 1000,
    }),
  });

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.choices[0].message.content).toBeDefined();
});

test("Kimi K2.5 via Azure AI Inference", async () => {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "kimi-k2.5",
      messages: [{ role: "user", content: "Hello" }],
      max_completion_tokens: 500,
    }),
  });

  expect(res.status).toBe(200);
});

test("Anthropic thinking mode request", async () => {
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: "Solve this" }],
    }),
  });

  expect(res.status).toBe(200);
});

test("PAT revocation blocks subsequent requests", async () => {
  // First request succeeds
  const res1 = await app.request("/v1/models", {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(res1.status).toBe(200);

  // Revoke the token
  await app.request("/admin/pat/revoke", {
    method: "POST",
    headers: { Authorization: "Bearer admin-token" },
    body: JSON.stringify({ pat_id: "test-pat-id", reason: "Test" }),
  });

  // Subsequent request fails
  const res2 = await app.request("/v1/models", {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(res2.status).toBe(401);
  const data = await res2.json();
  expect(data.error.message).toContain("revoked");
});

test("quota enforcement blocks over-budget requests", async () => {
  // Setup user with $0 budget

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer zero-budget-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });

  expect(res.status).toBe(429);
  const data = await res.json();
  expect(data.error.code).toBe("quota_exceeded");
});
```

### 7.3 Load Testing

```bash
# Using k6
k6 run --vus 100 --duration 5m load-test.js
```

```javascript
// tests/load/load-test.js
import http from "k6/http";
import { check } from "k6";

export default function () {
  const res = http.post(
    "http://localhost:3000/v1/chat/completions",
    JSON.stringify({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
      max_completion_tokens: 100,
    }),
    {
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
    },
  );

  check(res, {
    "status is 200": (r) => r.status === 200,
    "response time < 500ms": (r) => r.timings.duration < 500,
  });
}
```

---

## 8. Deployment Guide

### 8.1 Docker Compose (Local Development)

```yaml
# docker-compose.yml
version: "3.8"

services:
  gateway:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/llm_gateway
      # Azure Auth (choose one per deployment)
      - AZURE_TENANT_ID=${AZURE_TENANT_ID}
      - AZURE_CLIENT_ID=${AZURE_CLIENT_ID}
      - AZURE_CLIENT_SECRET=${AZURE_CLIENT_SECRET}
      # Or use API keys
      - AZURE_OPENAI_API_KEY=${AZURE_OPENAI_API_KEY}
      - AZURE_AI_INFERENCE_API_KEY=${AZURE_AI_INFERENCE_API_KEY}
      # Endpoints
      - AZURE_OPENAI_ENDPOINT=${AZURE_OPENAI_ENDPOINT}
      - AZURE_AI_INFERENCE_ENDPOINT=${AZURE_AI_INFERENCE_ENDPOINT}
    depends_on:
      - redis
      - db
    volumes:
      - ./config:/app/config

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  db:
    image: postgres:18-alpine
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=llm_gateway
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

### 8.2 Kubernetes Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: llm-gateway
spec:
  replicas: 3
  selector:
    matchLabels:
      app: llm-gateway
  template:
    metadata:
      labels:
        app: llm-gateway
    spec:
      containers:
        - name: gateway
          image: llm-gateway:latest
          ports:
            - containerPort: 3000
          env:
            - name: NODE_ENV
              value: "production"
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: redis-secret
                  key: url
            - name: AZURE_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: azure-secret
                  key: client-secret
            - name: AZURE_AI_INFERENCE_API_KEY
              valueFrom:
                secretKeyRef:
                  name: azure-secret
                  key: inference-api-key
          resources:
            requests:
              memory: "512Mi"
              cpu: "500m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
```

### 8.3 Environment Checklist

**Required Secrets:**

- [ ] `AZURE_TENANT_ID` (if using Entra ID)
- [ ] `AZURE_CLIENT_ID` (if using Entra ID)
- [ ] `AZURE_CLIENT_SECRET` (if using Entra ID)
- [ ] `AZURE_OPENAI_API_KEY` (if using API Key auth for OpenAI)
- [ ] `AZURE_AI_INFERENCE_API_KEY` (if using API Key auth for Inference)
- [ ] `AZURE_OPENAI_ENDPOINT`
- [ ] `AZURE_AI_INFERENCE_ENDPOINT`
- [ ] `REDIS_URL`
- [ ] `DATABASE_URL`
- [ ] `PAT_SECRET` (for signing tokens)

**Configuration Files:**

- [ ] `config/pricing.json` (mounted as volume)
- [ ] `config/deployments.ts` (Azure deployment mapping)

**Monitoring:**

- [ ] OpenTelemetry endpoint configured
- [ ] Log aggregation (Loki/ELK)
- [ ] Metrics dashboard (Grafana)
- [ ] Alerting rules (PagerDuty/Opsgenie)

---

## 9. Operational Runbooks

### 9.1 Adding a New Model

1. Deploy model in Azure AI Foundry
2. Add pricing to `config/pricing.json`:
   ```json
   "new-model": {
     "deployment_pattern": "*new-model*",
     "input_per_million": 1.00,
     "output_per_million": 5.00,
     "thinking_tokens_per_million": 1.00
   }
   ```
3. Update `config/deployments.ts` with endpoint and auth configuration
4. Add model alias mapping
5. Reload configuration (SIGUSR1 or restart)
6. Verify with test request

### 9.2 Switching Auth Method (Entra ID ↔ API Key)

```typescript
// Update deployment config
{
  name: 'gpt-5.4-global',
  modelName: 'gpt-5.4',
  endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
  auth: {
    type: 'api-key', // Change from 'entra-id'
    apiKey: process.env.AZURE_OPENAI_API_KEY,
  },
  apiVersion: '2025-01-01-preview',
}
```

No restart required if using hot-reload.

### 9.3 Revoking a Compromised PAT

```bash
# Immediate revocation
curl -X POST https://gateway.example.com/admin/pat/revoke \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "pat_id": "compromised-pat-uuid",
    "reason": "Security incident - key exposed in public repo"
  }'

# Verify in Redis
redis-cli GET blocklist:pat:compromised-pat-uuid
# Should return: 1
```

### 9.4 Handling Azure Outage

1. Check circuit breaker status: `GET /health`
2. If deployment unhealthy, traffic auto-routes to fallback
3. Monitor fallback latency and cost impact
4. Communicate to users about model substitution
5. Escalate to Azure support with `x-ms-client-request-id`

### 9.5 Quota Dispute Resolution

1. Query user usage: `SELECT * FROM request_audit WHERE user_id = 'xxx'`
2. Compare gateway calculation vs Azure invoice
3. If variance > 1%, investigate:
   - Token counting differences
   - Cache discount application
   - Thinking token billing
   - Partial stream consumption
4. Manual adjustment in Redis if needed:
   ```bash
   redis-cli HINCRBYFLOAT quota:user:2026-03 spent -1.50
   ```

---

## 10. Common Pitfalls & Solutions

| Pitfall                                 | Solution                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| **Memory leaks in streaming**           | Use TransformStream with backpressure, set request timeouts      |
| **Token estimation drift**              | Always reconcile with Azure's usage field, never trust estimates |
| **Redis connection drops**              | Use Redis Sentinel/Cluster, implement retry logic                |
| **Entra ID token expiry mid-request**   | 5-min buffer, retry on 401 with fresh token                      |
| **API Key rotation**                    | Support both keys during transition, hot-reload config           |
| **Protocol translation bugs**           | Extensive test suite with real client data                       |
| **Cost calculation precision**          | Use `decimal.js`, never native floating-point                    |
| **Circuit breaker flapping**            | Adjust thresholds based on Azure SLA (99.9%)                     |
| **PAT compromise**                      | Immediate revocation via admin endpoint, audit logging           |
| **max_tokens vs max_completion_tokens** | Accept both, prefer max_completion_tokens, warn on deprecated    |
| **Thinking token billing**              | Include in cost calculation, track separately in observability   |
| **FW model name case sensitivity**      | Use case-insensitive pattern matching in pricing                 |

---

**Document Version:** 1.2  
**Last Updated:** 2026-03-15  
**Next Review:** 2026-04-15
