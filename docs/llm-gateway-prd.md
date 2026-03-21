# LLM Gateway - Product Requirements Document

**Version:** 1.2  
**Date:** 2026-03-15  
**Status:** Draft  
**Author:** Architecture Team

---

## 1. Executive Summary

### 1.1 Purpose

Build a high-performance LLM Gateway using TypeScript and Bun that serves as a unified model hub for developer CLI tools (opencode, Claude Code, Codex CLI). The gateway provides protocol normalization, USD-based quota management, and real-time cost tracking while proxying to Azure AI Foundry as the single backend provider.

### 1.2 Target Users

- **Developers** using CLI coding assistants (opencode, Claude Code, Codex CLI)
- **Platform teams** managing AI resource allocation across teams
- **Finance/Operations** requiring granular cost visibility and control

### 1.3 Key Value Propositions

1. **Protocol Compatibility**: Seamlessly bridge OpenAI (Chat Completions + Responses API) and Anthropic (Messages API) formats
2. **Cost Control**: Real-time USD quota enforcement with per-request cost calculation
3. **Unified Access**: Single endpoint for frontier models (GPT-5.4, GPT-5.3-Codex, Claude 4.5/4.6, Kimi K2.5, GLM-5, MiniMax M2.5) via Azure AI Foundry
4. **Flexible Authentication**: Support both Entra ID (client credentials) and API Key authentication per deployment

---

## 2. System Architecture

### 2.1 High-Level Design

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────────────────┐ │
│  │  Codex CLI   │  │ Claude Code  │  │ opencode / Other OpenAI Clients     │ │
│  │  (Responses  │  │  (Messages   │  │ (Chat Completions)                  │ │
│  │   API)       │  │   API)       │  │                                     │ │
│  └──────────────┘  └──────────────┘  └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ HTTPS + PAT Auth
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GATEWAY CORE (Bun)                                 │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  HTTP Layer                                                           │  │
│  │  • HTTP/2 Server with connection pooling                              │  │
│  │  • Bearer token authentication (Personal Access Tokens)               │  │
│  │  • Request ID generation & propagation                                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Protocol Router                                                      │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────────┐  │  │
│  │  │  OpenAI     │  │  Anthropic   │  │  Canonical Request           │  │  │
│  │  │  Adapter    │  │  Adapter     │  │  (Internal Format)           │  │  │
│  │  │             │  │              │  │                              │  │  │
│  │  │ • Chat      │  │ • Messages   │  │ • Normalized schema          │  │  │
│  │  │   Completions│ │   API        │  │ • Routing metadata           │  │  │
│  │  │ • Responses │  │ • Tool use   │  │ • Cost estimation            │  │  │
│  │  │   API       │  │   XML↔JSON   │  │ • Thinking mode support      │  │  │
│  │  └─────────────┘  └──────────────┘  └──────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Business Logic Layer                                                 │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────────┐  │  │
│  │  │   Quota     │  │   Cache      │  │   Deployment Router          │  │  │
│  │  │  Service    │  │  (Semantic)  │  │                              │  │  │
│  │  │             │  │              │  │ • Model alias resolution     │  │  │
│  │  │ • USD-based │  │ • Similarity │  │ • Fallback logic             │  │  │
│  │  │   budgets   │  │   threshold  │  │ • Circuit breaker            │  │  │
│  │  │ • Real-time │  │   0.95       │  │ • Health checks              │  │  │
│  │  │   tracking  │  │              │  │                              │  │  │
│  │  └─────────────┘  └──────────────┘  └──────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Azure Integration Layer                                              │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  Auth Strategy Manager                                          │  │  │
│  │  │  • Per-deployment auth configuration                            │  │  │
│  │  │  • Entra ID: Client credentials flow                            │  │  │
│  │  │  • API Key: Static key with rotation support                    │  │  │
│  │  │  • Token caching (Entra ID)                                     │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  HTTP Client Pool                                               │  │  │
│  │  │  • HTTP/2 persistent connections                                │  │  │
│  │  │  • 10-50 connections per endpoint                               │  │  │
│  │  │  • Connection warming                                           │  │  │
│  │  │  • Retry with exponential backoff                               │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ HTTPS + Auth (Entra ID or API Key)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AZURE AI FOUNDRY BACKEND                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Azure AI Inference (Unified)                          ││
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐││
│  │  │ GPT-5.4      │ │ GPT-5.3-Codex│ │ Claude 4.5/4.6│ │ Kimi K2.5        │││
│  │  │ (Azure       │ │ (Azure       │ │ (Azure AI     │ │ (FW-Kimi-K2.5)   │││
│  │  │  OpenAI)     │ │  OpenAI)     │ │  Inference)   │ │                  │││
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────────┘││
│  │  ┌──────────────┐ ┌──────────────┐                                       ││
│  │  │ GLM-5        │ │ MiniMax M2.5 │                                       ││
│  │  │ (FW-GLM-5)   │ │ (FW-MiniMax  │                                       ││
│  │  │              │ │  -M2.5)      │                                       ││
│  │  └──────────────┘ └──────────────┘                                       ││
│  │                                                                          ││
│  │  All models use OpenAI-compatible Chat Completions API                   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Technology Stack

| Component            | Technology                    | Rationale                                           |
| -------------------- | ----------------------------- | --------------------------------------------------- |
| **Runtime**          | Bun 1.2+                      | Native TypeScript, fast HTTP/2, efficient streaming |
| **Web Framework**    | Hono 4.x                      | Lightweight, Bun-optimized, middleware support      |
| **Authentication**   | Entra ID (Azure AD) + API Key | Flexible per-deployment auth                        |
| **Token Cache**      | In-memory (Map) + Redis       | 50-min TTL for Entra ID tokens                      |
| **Quota Store**      | Redis 7.x                     | Atomic operations, Lua scripts for consistency      |
| **Persistent Data**  | PostgreSQL 18                 | Audit logs, usage history, user management          |
| **Observability**    | OpenTelemetry 1.x             | Vendor-neutral, traces + metrics                    |
| **Cost Calculation** | decimal.js                    | Precise currency math, no floating-point errors     |

---

## 3. Functional Requirements

### 3.1 Authentication & Authorization

#### 3.1.1 Personal Access Tokens (PAT)

```
Format: lg_<userId>_<random>_<signature>
Example: lg_user_123_abc123def_signature
```

**Requirements:**

- [x] PAT generation with HMAC-SHA256 signature
- [x] Prefix-based identification (`lg_prod_`, `lg_test_`)
- [x] Support multiple active keys per user
- [x] **PAT Revocation**: Immediate invalidation via blocklist in Redis
- [x] Scope validation: `all`, `read`, `models:<name>`

**PAT Revocation Flow:**

```
1. Admin/API call: POST /admin/pat/revoke { tokenId }
2. Add to Redis blocklist: blocklist:pat:<tokenId> = 1 [TTL: until token expiry]
3. All auth middleware checks blocklist before signature verification
4. Revoked tokens return 401 with "Token revoked" message
```

#### 3.1.2 Azure Authentication (Per-Deployment)

Each deployment can be configured with either:

**Option A: Entra ID (Client Credentials)**

```typescript
{
  name: "gpt-5.4-global",
  authType: "entra-id",
  tenantId: "...",
  clientId: "...",
  clientSecret: "...",
  scope: "https://cognitiveservices.azure.com/.default"
}
```

**Option B: API Key**

```typescript
{
  name: "gpt-5.4-global",
  authType: "api-key",
  apiKey: "${AZURE_OPENAI_API_KEY}",
  keyHeader: "api-key" // or "Authorization"
}
```

**Requirements:**

- [x] Per-deployment auth configuration
- [x] Entra ID: Client credentials flow with token caching
- [x] API Key: Static key with optional rotation support
- [x] Automatic token refresh (Entra ID) 5 minutes before expiry
- [x] JWT decoding to extract `exp` claim (Entra ID)

### 3.2 Protocol Compatibility

#### 3.2.1 OpenAI Chat Completions API

**Endpoint:** `POST /v1/chat/completions`

**Requirements:**

- [x] Full compatibility with OpenAI SDK clients
- [x] Support `stream: true` (SSE streaming)
- [x] Support `tools` and `tool_choice`
- [x] Support `response_format` (JSON mode)
- [x] Temperature, `max_completion_tokens` (NOT `max_tokens`), top_p, presence_penalty, frequency_penalty
- [x] Proper error code mapping (400, 401, 429, 500, 503)

**Important**: Modern OpenAI API uses `max_completion_tokens` instead of `max_tokens`. The gateway must:

- Accept `max_completion_tokens` from clients
- Map to appropriate Azure parameter based on model version
- Support both parameters for backward compatibility (warn on deprecated `max_tokens`)

#### 3.2.2 OpenAI Responses API (Codex CLI)

**Endpoint:** `POST /v1/responses`

**Requirements:**

- [x] Support `input` field (string or array format)
- [x] Support `tools` with built-in types (file_read, shell_exec)
- [x] Support `reasoning` parameter for GPT-5.3-Codex
- [x] Transform to Azure OpenAI Chat Completions format
- [x] Stream format: `response.output_item.done` events
- [x] Tool result integration

#### 3.2.3 Anthropic Messages API (Claude Code)

**Endpoint:** `POST /v1/messages`

**Requirements:**

- [x] Support `messages` array with `role`, `content`
- [x] Support `system` as string or array
- [x] Support `max_tokens` (required in Anthropic, optional in OpenAI)
- [x] Support `tools` with XML-style tool use
- [x] Support `tool_choice` (auto, any, tool)
- [x] **Thinking Mode Support**:
  - [x] `thinking: { type: "enabled", budget_tokens: number }`
  - [x] Transform thinking blocks to/from Azure format
  - [x] Include thinking tokens in cost calculation
- [x] Bidirectional translation:
  - Anthropic → OpenAI (for GPT fallback)
  - OpenAI → Anthropic (for Claude backend)
- [x] Streaming format: `content_block_delta` events
- [x] Tool use block IDs preservation

**Thinking Mode Handling:**

```typescript
// Anthropic thinking request
{
  "model": "claude-opus-4-6",
  "max_tokens": 8192,
  "thinking": { "type": "enabled", "budget_tokens": 2048 },
  "messages": [...]
}

// Transformed to Azure AI Inference format
{
  "model": "claude-opus-4-6",
  "max_tokens": 8192,
  "thinking": { "type": "enabled", "budget_tokens": 2048 },
  // ... rest of request
}
```

#### 3.2.4 Model Listing

**Endpoint:** `GET /v1/models`

**Requirements:**

- [x] Return unified model list across all Azure deployments
- [x] Include model aliases (e.g., `claude-opus-4-6` → actual deployment)
- [x] Filter by user permissions
- [x] **Frontier Model Support**:
  - [x] GPT-5.4
  - [x] GPT-5.3-Codex
  - [x] Claude Haiku 4.5
  - [x] Claude Sonnet 4.6
  - [x] Claude Opus 4.6
  - [x] Kimi K2.5 (FW-Kimi-K2.5)
  - [x] GLM-5 (FW-GLM-5)
  - [x] MiniMax M2.5 (FW-MiniMax-M2.5)

### 3.3 Quota & Cost Management

#### 3.3.1 Pricing Configuration

**File:** `config/pricing.json`

```json
{
  "version": "2026-03-15",
  "currency": "USD",
  "models": {
    "gpt-5.4": {
      "deployment_pattern": "gpt-5.4-*",
      "input_per_million": 5.0,
      "output_per_million": 15.0,
      "cache_discount": 0.5
    },
    "gpt-5.3-codex": {
      "deployment_pattern": "gpt-5.3-codex-*",
      "input_per_million": 4.0,
      "output_per_million": 12.0
    },
    "claude-opus-4-6": {
      "deployment_pattern": "claude-opus-4-6-*",
      "input_per_million": 15.0,
      "output_per_million": 75.0,
      "cache_write_per_million": 18.75,
      "cache_read_per_million": 1.5,
      "thinking_tokens_per_million": 15.0
    },
    "claude-sonnet-4-6": {
      "deployment_pattern": "claude-sonnet-4-6-*",
      "input_per_million": 3.0,
      "output_per_million": 15.0,
      "thinking_tokens_per_million": 3.0
    },
    "claude-haiku-4-5": {
      "deployment_pattern": "claude-haiku-4-5-*",
      "input_per_million": 0.25,
      "output_per_million": 1.25
    },
    "kimi-k2.5": {
      "deployment_pattern": "*kimi*",
      "input_per_million": 2.5,
      "output_per_million": 10.0
    },
    "glm-5": {
      "deployment_pattern": "*glm*",
      "input_per_million": 2.0,
      "output_per_million": 8.0
    },
    "minimax-m2.5": {
      "deployment_pattern": "*minimax*",
      "input_per_million": 1.8,
      "output_per_million": 7.2
    }
  }
}
```

**Requirements:**

- [x] Hot-reload without restart (file watcher)
- [x] Pattern matching for deployment names
- [x] Support cache pricing (write/read differential)
- [x] **Thinking tokens pricing** for Claude models
- [x] Decimal precision (6 decimal places for USD)

#### 3.3.2 Quota Enforcement Flow

**Reservation Pattern:**

1. **Estimate:** Calculate 120% of estimated cost (input + output tokens + thinking tokens)
2. **Reserve:** Atomically check and reserve against monthly budget
3. **Stream:** Proxy Azure response with real-time tracking
4. **Reconcile:** Adjust reservation to actual usage from Azure response
5. **Refund:** Return unused reservation amount

**Requirements:**

- [x] Atomic quota check with Redis Lua scripts
- [x] Reservation TTL: 5 minutes (cleanup orphaned reservations)
- [x] Monthly reset with automatic archival
- [x] Hard limit vs. soft limit modes
- [x] Quota exceeded response: HTTP 429 with `X-Quota-Remaining: 0`

#### 3.3.3 Token Estimation

- [x] OpenAI models: tiktoken with `cl100k_base`
- [x] Claude models: Estimate at 1.1x OpenAI count (different tokenizer)
- [x] **Thinking tokens**: Add 20% buffer for thinking-enabled requests
- [x] Fallback: 4 characters per token + 100 overhead
- [x] Pre-request estimation for reservation

#### 3.3.4 Real-Time Cost Calculation

```typescript
Cost = (input_tokens / 1,000,000 × input_rate)
     + (output_tokens / 1,000,000 × output_rate)
     + (thinking_tokens / 1,000,000 × thinking_rate) // For Claude thinking mode
```

**Requirements:**

- [x] Use `usage` field from Azure response (authoritative)
- [x] Never use client-reported token counts for billing
- [x] Handle missing usage (error/timeout) as $0 charge
- [x] Support Azure prompt caching discounts when reported
- [x] **Support thinking token billing** for Claude models

### 3.4 Routing & Resilience

#### 3.4.1 Deployment Configuration

All models are accessed through Azure AI Inference with OpenAI-compatible Chat Completions API:

```typescript
interface AzureDeployment {
  name: string; // Internal reference
  modelName: string; // Model identifier (e.g., "FW-Kimi-K2.5")
  endpoint: string; // Azure AI Inference endpoint
  authType: "entra-id" | "api-key";
  // For Entra ID
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  // For API Key
  apiKey?: string;
  apiVersion: string; // "2024-12-01-preview" or similar
}
```

**Model Alias Resolution:**
| Client Request | Azure Model Name | Fallback |
|----------------|------------------|----------|
| `gpt-5.4` | gpt-5.4 | gpt-5.4-backup |
| `gpt-5.3-codex` | gpt-5.3-codex | None |
| `claude-opus-4-6` | claude-opus-4-6 | GPT-5.4 (with translation) |
| `claude-sonnet-4-6` | claude-sonnet-4-6 | Claude Haiku 4.5 |
| `claude-haiku-4-5` | claude-haiku-4-5 | None |
| `kimi-k2.5` | FW-Kimi-K2.5 | None |
| `glm-5` | FW-GLM-5 | None |
| `minimax-m2.5` | FW-MiniMax-M2.5 | None |

**Requirements:**

- [x] Health check every 30 seconds
- [x] Circuit breaker: 5 failures → open for 30 seconds
- [x] Automatic failover with protocol translation
- [x] Sticky sessions for multi-turn conversations (optional)

#### 3.4.2 Retry Logic

- [x] Exponential backoff: 1s, 2s, 4s, 8s (max 30s)
- [x] Jitter: ±1s randomization
- [x] Respect `Retry-After` header from Azure
- [x] Max 3 retries per request
- [x] Non-retryable errors: 400, 401, 403

#### 3.4.3 Rate Limiting

- [x] Per-user: 100 requests/minute
- [x] Per-user: 100,000 tokens/minute
- [x] Per-deployment: Respect Azure TPM/RPM limits
- [x] Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`

### 3.5 Caching

#### 3.5.1 Semantic Cache (Optional V2)

- [x] Embedding-based similarity matching
- [x] Threshold: 0.95 cosine similarity
- [x] TTL: 1 hour
- [x] Cache key: hash of normalized request
- [x] Bypass cache for `tool_choice: required`

---

## 4. Non-Functional Requirements

### 4.1 Performance

| Metric                 | Target           | Measurement                         |
| ---------------------- | ---------------- | ----------------------------------- |
| **P50 Latency**        | < 50ms overhead  | Gateway time only (excluding Azure) |
| **P99 Latency**        | < 100ms overhead | Including auth + quota check        |
| **Throughput**         | 10,000 req/min   | Per instance                        |
| **Streaming TTFB**     | < 100ms          | Time to first token from Azure      |
| **Concurrent Streams** | 1,000            | Per instance                        |

**Optimization Requirements:**

- [x] HTTP/2 connection pooling (10-50 persistent connections)
- [x] Connection warming on startup
- [x] Zero-copy streaming (TransformStream, no buffering)
- [x] Redis pipeline for quota operations
- [x] Token estimation cache (avoid repeated tiktoken encoding)

### 4.2 Reliability

| Metric            | Target              |
| ----------------- | ------------------- |
| **Uptime**        | 99.9%               |
| **Error Rate**    | < 0.1% (5xx errors) |
| **Recovery Time** | < 30 seconds        |

**Requirements:**

- [x] Graceful degradation (fail open for non-critical paths)
- [x] Health check endpoint: `GET /health`
- [x] Readiness probe: `GET /ready` (checks Redis + Azure connectivity)
- [x] Graceful shutdown: 30s timeout for in-flight requests

### 4.3 Security

- [x] TLS 1.3 for all connections
- [x] No logging of message content (only metadata)
- [x] PAT storage: HMAC hash only (irreversible)
- [x] API Key storage: Environment variables or Azure Key Vault
- [x] Request/response sanitization (remove PII from logs)
- [x] CORS configuration for web clients (if applicable)

### 4.4 Observability

#### 4.4.1 Tracing (OpenTelemetry)

**Span Attributes:**

```
llm.user_id: string
llm.model: string
llm.provider: "azure"
llm.deployment: string
llm.tokens.input: number
llm.tokens.output: number
llm.tokens.thinking: number  // NEW: Thinking tokens
llm.tokens.total: number
llm.cost.usd: number
llm.cache_hit: boolean
llm.latency.first_token: number (ms)
llm.protocol: "openai-chat" | "openai-responses" | "anthropic"
llm.stream_duration: number (ms)
llm.thinking.enabled: boolean  // NEW
llm.thinking.budget_tokens: number  // NEW
azure.request_id: string (x-ms-client-request-id)
azure.region: string
azure.auth_type: "entra-id" | "api-key"  // NEW
```

**Requirements:**

- [x] Trace ID propagation to Azure (`x-ms-client-request-id`)
- [x] Baggage for user context
- [x] Sampling: 100% for errors, 10% for success

#### 4.4.2 Metrics

```
http_requests_total{method, route, status}
http_request_duration_seconds{quantile}
llm_tokens_total{model, type="input|output|thinking"}
llm_cost_usd_total{user_id, model}
llm_quota_remaining_ratio{user_id}
llm_thinking_requests_total{model}
azure_token_refresh_total{status, auth_type}
azure_rate_limit_hits_total{deployment}
circuit_breaker_state{deployment}
cache_hit_ratio
```

#### 4.4.3 Logging

**Structured JSON logs:**

```json
{
  "timestamp": "2026-03-15T10:30:00Z",
  "level": "info",
  "trace_id": "abc123",
  "user_id": "user_123",
  "event": "request_complete",
  "model": "FW-Kimi-K2.5",
  "deployment": "kimi-k2.5-global",
  "tokens_input": 1000,
  "tokens_output": 500,
  "tokens_thinking": 800,
  "cost_usd": 0.0675,
  "thinking_enabled": true,
  "azure_auth_type": "api-key",
  "duration_ms": 2500,
  "status": 200
}
```

**Log Levels:**

- ERROR: 5xx errors, auth failures, quota violations
- WARN: 4xx errors, retries, circuit breaker triggers
- INFO: Request completion, token refresh
- DEBUG: Request/response bodies (dev only)

---

## 5. Data Model

### 5.1 Redis Schema

```
# Quota tracking
quota:{user_id}:{YYYY-MM} → Hash
  ├─ budget: string (USD)
  ├─ spent: string (USD)
  └─ reset_date: string

reserved:{user_id}:{YYYY-MM} → String
  └─ total_reserved: string (USD)

reservation:{reservation_id} → String
  └─ amount: string (USD) [TTL: 300s]

# PAT Revocation Blocklist
blocklist:pat:{token_id} → String
  └─ "1" [TTL: until token expiry]

# Rate limiting
ratelimit:{user_id}:requests → String [TTL: 60s]
ratelimit:{user_id}:tokens → String [TTL: 60s]

# Cache (optional)
cache:{hash} → String [TTL: 3600s]
```

### 5.2 PostgreSQL Schema

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    monthly_budget_usd DECIMAL(10, 6) NOT NULL DEFAULT 50.00,
    hard_limit BOOLEAN DEFAULT true,
    rate_limit_tier VARCHAR(20) DEFAULT 'standard',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- API Keys (PATs)
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(255) NOT NULL,
    prefix VARCHAR(20) NOT NULL,
    scope VARCHAR(50) DEFAULT 'all',
    expires_at TIMESTAMP,
    revoked_at TIMESTAMP,  -- NEW: Revocation timestamp
    revoked_reason TEXT,   -- NEW: Optional reason
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Usage history (archived from Redis monthly)
CREATE TABLE usage_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    month VARCHAR(7) NOT NULL, -- YYYY-MM
    total_requests INTEGER DEFAULT 0,
    total_tokens_input BIGINT DEFAULT 0,
    total_tokens_output BIGINT DEFAULT 0,
    total_tokens_thinking BIGINT DEFAULT 0,  -- NEW
    total_cost_usd DECIMAL(12, 6) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Request audit log (compliance)
CREATE TABLE request_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    request_id VARCHAR(255),
    model VARCHAR(100),
    deployment VARCHAR(100),
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_thinking INTEGER,  -- NEW
    cost_usd DECIMAL(10, 6),
    thinking_enabled BOOLEAN DEFAULT false,  -- NEW
    azure_auth_type VARCHAR(20),  -- NEW
    duration_ms INTEGER,
    status_code INTEGER,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- PAT Revocation Log (NEW)
CREATE TABLE pat_revocation_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pat_id UUID REFERENCES api_keys(id),
    revoked_by UUID REFERENCES users(id),
    revoked_at TIMESTAMP DEFAULT NOW(),
    reason TEXT
);
```

---

## 6. API Specification

### 6.1 Authentication

**Header:** `Authorization: Bearer {pat_token}`

**Error Response (401):**

```json
{
  "error": {
    "type": "authentication_error",
    "message": "Invalid API key"
  }
}
```

### 6.2 Endpoints

#### POST /v1/chat/completions

OpenAI-compatible chat completions.

**Request:**

```json
{
  "model": "gpt-5.4",
  "messages": [
    { "role": "system", "content": "You are helpful" },
    { "role": "user", "content": "Hello" }
  ],
  "stream": true,
  "temperature": 0.7,
  "max_completion_tokens": 1000
}
```

**Response (Streaming):**

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]
```

#### POST /v1/responses

OpenAI Responses API (Codex CLI).

**Request:**

```json
{
  "model": "gpt-5.3-codex",
  "input": "Write a Python function to sort a list",
  "tools": [{ "type": "file_search" }],
  "reasoning": { "effort": "high" }
}
```

#### POST /v1/messages

Anthropic Messages API (Claude Code).

**Request (with Thinking):**

```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 8192,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 2048
  },
  "messages": [
    { "role": "user", "content": "Solve this complex math problem" }
  ],
  "system": "You are Claude"
}
```

**Response (Streaming with Thinking):**

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_123","model":"claude-opus-4-6"}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me analyze this step by step..."}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The solution is..."}}

event: message_stop
data: {"type":"message_stop"}
```

#### GET /v1/models

List available models.

**Response:**

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-5.4",
      "object": "model",
      "created": 1694268190,
      "owned_by": "azure"
    },
    {
      "id": "gpt-5.3-codex",
      "object": "model",
      "created": 1694268190,
      "owned_by": "azure"
    },
    {
      "id": "claude-opus-4-6",
      "object": "model",
      "created": 1694268190,
      "owned_by": "azure"
    },
    {
      "id": "claude-sonnet-4-6",
      "object": "model",
      "created": 1694268190,
      "owned_by": "azure"
    },
    {
      "id": "claude-haiku-4-5",
      "object": "model",
      "created": 1694268190,
      "owned_by": "azure"
    },
    {
      "id": "kimi-k2.5",
      "object": "model",
      "created": 1694268190,
      "owned_by": "azure"
    },
    {
      "id": "glm-5",
      "object": "model",
      "created": 1694268190,
      "owned_by": "azure"
    },
    {
      "id": "minimax-m2.5",
      "object": "model",
      "created": 1694268190,
      "owned_by": "azure"
    }
  ]
}
```

#### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "version": "1.2.0",
  "timestamp": "2026-03-15T10:30:00Z"
}
```

#### GET /quota

Get current quota status (custom endpoint).

**Response:**

```json
{
  "monthly_budget_usd": 50.0,
  "spent_usd": 23.45,
  "reserved_usd": 1.2,
  "remaining_usd": 25.35,
  "reset_date": "2026-04-01T00:00:00Z"
}
```

### 6.3 Admin Endpoints (NEW)

#### POST /admin/pat/revoke

Revoke a PAT immediately.

**Request:**

```json
{
  "pat_id": "uuid-of-the-pat",
  "reason": "Security incident - key compromised"
}
```

**Response:**

```json
{
  "success": true,
  "revoked_at": "2026-03-15T10:30:00Z",
  "message": "Token revoked successfully"
}
```

---

## 7. Error Handling

### 7.1 Error Response Format

**OpenAI Format (default):**

```json
{
  "error": {
    "type": "insufficient_quota",
    "message": "Monthly budget exceeded",
    "param": null,
    "code": "quota_exceeded"
  }
}
```

**Anthropic Format (when client uses Messages API):**

```json
{
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "Monthly budget exceeded"
  }
}
```

### 7.2 Error Codes

| HTTP | Code                    | Description              |
| ---- | ----------------------- | ------------------------ |
| 400  | `invalid_request_error` | Malformed request        |
| 401  | `authentication_error`  | Invalid or revoked PAT   |
| 403  | `permission_error`      | Insufficient scope       |
| 429  | `rate_limit_exceeded`   | Too many requests        |
| 429  | `quota_exceeded`        | Monthly budget exhausted |
| 502  | `bad_gateway`           | Azure unavailable        |
| 503  | `service_unavailable`   | Gateway overloaded       |

---

## 8. Deployment

### 8.1 Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=production

# Azure Entra ID (for deployments using client credentials)
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=

# Azure OpenAI (for GPT models)
AZURE_OPENAI_ENDPOINT=https://{resource}.openai.azure.com/
AZURE_OPENAI_API_KEY=  # Optional: if using API key auth

# Azure AI Inference (for Claude, Kimi, GLM, MiniMax)
AZURE_AI_INFERENCE_ENDPOINT=https://{region}.services.ai.azure.com/
AZURE_AI_INFERENCE_API_KEY=  # Optional: if using API key auth

# Redis
REDIS_URL=redis://localhost:6379

# PostgreSQL
DATABASE_URL=postgresql://user:pass@localhost:5432/llm_gateway

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_SERVICE_NAME=llm-gateway
LOG_LEVEL=info
```

### 8.2 Docker Configuration

```dockerfile
FROM oven/bun:1.2-slim

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --production

COPY . .
COPY config/pricing.json ./config/

EXPOSE 3000

USER bun

CMD ["bun", "run", "src/index.ts"]
```

### 8.3 Scaling Considerations

- **Horizontal:** Stateless design allows multiple instances behind load balancer
- **Sticky sessions:** Not required (stateless)
- **Redis:** Use Redis Cluster for high availability
- **Connection pools:** Per-instance pools (10-50 connections each)

---

## 9. Development Phases

### Phase 1: Core Gateway (Week 1-2)

- [ ] HTTP server with Hono
- [ ] PAT authentication with revocation support
- [ ] Flexible Azure auth (Entra ID + API Key)
- [ ] Azure AI Inference proxy (OpenAI-compatible)
- [ ] Basic quota tracking
- [ ] Health checks

### Phase 2: Protocol Adapters (Week 3-4)

- [ ] OpenAI Chat Completions full compatibility
- [ ] OpenAI Responses API (Codex)
- [ ] Anthropic Messages API with thinking mode
- [ ] Protocol translation layer
- [ ] Model listing with frontier models

### Phase 3: Cost & Quota (Week 5-6)

- [ ] JSON pricing configuration with thinking tokens
- [ ] Token estimation
- [ ] Real-time cost calculation
- [ ] Reservation pattern implementation
- [ ] Monthly quota reset

### Phase 4: Resilience (Week 7-8)

- [ ] Connection pooling
- [ ] Circuit breaker
- [ ] Retry logic with backoff
- [ ] Fallback routing
- [ ] Rate limiting

### Phase 5: Observability (Week 9-10)

- [ ] OpenTelemetry traces with thinking attributes
- [ ] Metrics collection
- [ ] Structured logging
- [ ] Dashboards (Grafana)

### Phase 6: Advanced Features (Week 11-12)

- [ ] Semantic caching
- [ ] Multi-region support
- [ ] Admin API
- [ ] Usage analytics

---

## 10. Risks & Mitigations

| Risk                          | Impact | Mitigation                                                 |
| ----------------------------- | ------ | ---------------------------------------------------------- |
| **Azure rate limits**         | High   | Circuit breaker, exponential backoff, fallback deployments |
| **Token estimation error**    | Medium | 120% reservation buffer, reconcile actual usage            |
| **Redis downtime**            | High   | Fail open (allow requests), local in-memory fallback       |
| **Entra ID token expiry**     | Medium | 5-min buffer, background refresh, retry on 401             |
| **API Key rotation**          | Medium | Support both keys during transition, hot-reload config     |
| **Protocol translation bugs** | High   | Extensive test suite, feature flags for new adapters       |
| **Cost calculation drift**    | Medium | Monthly reconciliation, alerts on variance > 5%            |
| **Memory leaks (streaming)**  | Medium | Backpressure handling, request timeouts, heap monitoring   |
| **PAT compromise**            | High   | Immediate revocation endpoint, audit logging               |

---

## 11. Success Metrics

| Metric                 | Target            | Measurement                          |
| ---------------------- | ----------------- | ------------------------------------ |
| **Adoption**           | 100+ active users | Monthly active PATs                  |
| **Cost Accuracy**      | < 1% variance     | Gateway calc vs Azure invoice        |
| **Quota Enforcement**  | 100% accuracy     | No over-budget incidents             |
| **Uptime**             | 99.9%             | External monitoring                  |
| **P50 Latency**        | < 50ms overhead   | APM traces                           |
| **Error Rate**         | < 0.1%            | 5xx responses                        |
| **Revocation Latency** | < 1 second        | Time from revoke call to enforcement |

---

## 12. Appendix

### 12.1 Glossary

- **PAT**: Personal Access Token (client authentication)
- **Entra ID**: Microsoft Azure Active Directory (now Microsoft Entra)
- **TTFB**: Time To First Byte (streaming latency)
- **TPM**: Tokens Per Minute (Azure rate limit)
- **RPM**: Requests Per Minute (Azure rate limit)
- **Thinking Mode**: Claude's extended reasoning capability with token budget

### 12.2 References

- [Azure OpenAI REST API](https://learn.microsoft.com/en-us/azure/ai-services/openai/reference)
- [Azure AI Inference API](https://learn.microsoft.com/en-us/azure/ai-studio/reference/reference-model-inference-api)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- [Anthropic Messages API](https://docs.anthropic.com/claude/reference/messages_post)
- [Anthropic Extended Thinking](https://docs.anthropic.com/claude/docs/extended-thinking)
- [OpenTelemetry Specification](https://opentelemetry.io/docs/specs/)

---

**Document Control:**

- Review Date: 2026-04-15
- Approvers: Architecture Team, Security Team, Finance Team
