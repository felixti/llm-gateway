# Requirements Document

## Introduction

The LLM Gateway is a high-performance proxy built with TypeScript and Bun (Hono framework) that provides a unified model hub for developer CLI tools (opencode, Claude Code, Codex CLI). The gateway supports two distinct protocol paths with no cross-protocol translation:

- **OpenAI-compatible path** (`/v1/chat/completions`, `/v1/responses`): For GPT models (Azure OpenAI) and third-party models from Azure AI Foundry (Kimi K2.5, GLM-5, MiniMax M2.5) which all expose an OpenAI-compatible Chat Completions API.
- **Anthropic Messages path** (`/v1/messages`): For Claude models (Claude Haiku 4.5, Claude Sonnet 4.6, Claude Opus 4.6) served via Azure AI Foundry, which expose the native Anthropic Messages API. There is no translation between Chat Completions and Messages API — Claude models are only accessible via the Anthropic protocol.

The gateway enforces USD-based quota management, real-time cost tracking, and provides resilience patterns (circuit breaker, retry, fallback routing within the same protocol family). HTTP test files (.http) are provided for all endpoints to enable quick manual and CI-based endpoint validation.

**Backend providers:**
- **Azure OpenAI**: GPT-5.4, GPT-5.3-Codex
- **Azure AI Foundry**: Claude Haiku 4.5, Claude Sonnet 4.6, Claude Opus 4.6 (Anthropic Messages API), Kimi K2.5, GLM-5, MiniMax M2.5 (OpenAI-compatible Chat Completions API)

#[[file:docs/llm-gateway-prd.md]]

## Requirements

### Requirement 1: PAT Authentication & Revocation

**User Story:** As a developer, I want to authenticate to the gateway using a Personal Access Token so that I can securely access LLM models without managing Azure credentials directly.

#### Acceptance Criteria

1. WHEN a request arrives with a valid `Authorization: Bearer {pat}` header THEN the gateway SHALL verify the HMAC-SHA256 signature and extract the user identity.
2. WHEN a PAT has the prefix format `lg_{env}_{userId}_{random}_{signature}` THEN the gateway SHALL parse the environment (prod/test) and user ID from the prefix.
3. WHEN a PAT has expired (current time > `exp` claim) THEN the gateway SHALL return HTTP 401 with `{"error": {"type": "authentication_error", "message": "Token expired"}}`.
4. WHEN a PAT has been revoked via the admin endpoint THEN the gateway SHALL check the Redis blocklist (`blocklist:pat:{jti}`) and return HTTP 401 with `"Token has been revoked"`.
5. WHEN a user has multiple active PATs THEN the gateway SHALL validate each independently based on its own signature and expiry.
6. WHEN a PAT includes a scope claim (`all`, `read`, `models:<name>`) THEN the gateway SHALL enforce the scope against the requested operation.
7. IF no `Authorization` header is present or the header does not start with `Bearer ` THEN the gateway SHALL return HTTP 401 with `"Missing or invalid Authorization header"`.

### Requirement 2: Azure Per-Deployment Authentication

**User Story:** As a platform engineer, I want each Azure deployment to use either Entra ID client credentials or an API key so that I can configure the most appropriate auth method per model endpoint.

#### Acceptance Criteria

1. WHEN a deployment is configured with `authType: "entra-id"` THEN the gateway SHALL acquire a token via OAuth2 client credentials flow using `tenantId`, `clientId`, and `clientSecret`.
2. WHEN an Entra ID token is cached and its expiry is more than 5 minutes in the future THEN the gateway SHALL reuse the cached token without re-authenticating.
3. WHEN an Entra ID token is within 5 minutes of expiry THEN the gateway SHALL proactively acquire a fresh token in the background.
4. WHEN a deployment is configured with `authType: "api-key"` THEN the gateway SHALL send the key in the configured header (`api-key` or `Authorization: Bearer`).
5. WHEN an Entra ID token acquisition fails THEN the gateway SHALL return HTTP 502 and log the error with `azure.auth_type: "entra-id"`.
6. IF the deployment configuration changes at runtime THEN the gateway SHALL pick up the new auth configuration without restart (hot-reload).

### Requirement 3: OpenAI Chat Completions Protocol

**User Story:** As a developer using opencode or any OpenAI SDK client, I want to call `POST /v1/chat/completions` so that I get full compatibility with the standard OpenAI API for GPT models and Azure AI Foundry third-party models (Kimi, GLM, MiniMax).

#### Acceptance Criteria

1. WHEN a request is sent to `POST /v1/chat/completions` with `messages`, `model`, and optional parameters THEN the gateway SHALL transform it to the canonical internal format and proxy to the appropriate Azure backend (Azure OpenAI for GPT models, Azure AI Foundry for Kimi/GLM/MiniMax).
2. WHEN the requested model is a Claude model (claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5) THEN the gateway SHALL reject the request with HTTP 400 and a message indicating that Claude models are only available via `POST /v1/messages`.
3. WHEN the request includes `stream: true` THEN the gateway SHALL return SSE-formatted chunks (`data: {...}\n\n`) ending with `data: [DONE]\n\n`.
4. WHEN the request includes `tools` and `tool_choice` THEN the gateway SHALL pass them through to Azure and return tool call responses unchanged.
5. WHEN the request includes `response_format: { type: "json_object" }` THEN the gateway SHALL enable JSON mode on the Azure request.
6. WHEN the request uses `max_completion_tokens` THEN the gateway SHALL use it as the authoritative token limit parameter.
7. WHEN the request uses the deprecated `max_tokens` instead of `max_completion_tokens` THEN the gateway SHALL accept it for backward compatibility, map it to `max_completion_tokens`, and log a deprecation warning.
8. WHEN Azure returns an error (4xx/5xx) THEN the gateway SHALL map it to the appropriate OpenAI error format with correct HTTP status codes (400, 401, 429, 500, 503).

### Requirement 4: OpenAI Responses API Protocol (Codex CLI)

**User Story:** As a developer using Codex CLI, I want to call `POST /v1/responses` so that the gateway translates my Responses API requests to Azure Chat Completions for GPT models.

#### Acceptance Criteria

1. WHEN a request is sent to `POST /v1/responses` with an `input` field (string or array) THEN the gateway SHALL transform it into a Chat Completions-compatible messages array and proxy to Azure OpenAI.
2. WHEN the requested model is a Claude model THEN the gateway SHALL reject the request with HTTP 400 indicating Claude models are only available via `POST /v1/messages`.
3. WHEN the request includes `tools` with built-in types (`file_search`, `file_read`, `shell_exec`) THEN the gateway SHALL transform them to function-calling format for Azure.
4. WHEN the request includes `reasoning: { effort: "high" | "medium" | "low" }` THEN the gateway SHALL map it to the appropriate Azure reasoning parameters for GPT-5.3-Codex.
5. WHEN streaming is enabled THEN the gateway SHALL emit `response.output_item.done` events in the Responses API format.
6. WHEN the Azure response includes tool call results THEN the gateway SHALL integrate them back into the Responses API response format.

### Requirement 5: Anthropic Messages API Protocol (Claude Code)

**User Story:** As a developer using Claude Code, I want to call `POST /v1/messages` so that the gateway proxies my Anthropic Messages API requests natively to Claude models on Azure AI Foundry.

#### Acceptance Criteria

1. WHEN a request is sent to `POST /v1/messages` with `messages`, `model`, and `max_tokens` THEN the gateway SHALL proxy it to the Claude model deployment on Azure AI Foundry using the native Anthropic Messages API format (no conversion to Chat Completions).
2. WHEN the requested model is NOT a Claude model (e.g., gpt-5.4, kimi-k2.5) THEN the gateway SHALL reject the request with HTTP 400 indicating that non-Claude models are only available via `POST /v1/chat/completions`.
3. WHEN the request includes a `system` field (string or array) THEN the gateway SHALL pass it through natively to Azure AI Foundry.
4. WHEN the request includes `thinking: { type: "enabled", budget_tokens: N }` THEN the gateway SHALL pass the thinking configuration to Azure AI Foundry and track thinking tokens separately for billing.
5. WHEN streaming is enabled THEN the gateway SHALL pass through Anthropic-format SSE events (`message_start`, `content_block_start`, `content_block_delta`, `message_stop`) from Azure AI Foundry.
6. WHEN the request includes `tools` with Anthropic tool use format THEN the gateway SHALL pass them through natively to Azure AI Foundry and preserve tool use block IDs.
7. WHEN the request includes `tool_choice` with Anthropic values (`auto`, `any`, `tool`) THEN the gateway SHALL pass them through natively.
8. WHEN the Azure AI Foundry response contains thinking blocks THEN the gateway SHALL pass them through as native Anthropic `content_block_start`/`content_block_delta` events with type `thinking`.
9. WHEN errors occur THEN the gateway SHALL return them in Anthropic error format: `{"type": "error", "error": {"type": "...", "message": "..."}}`.
10. WHEN a Claude model deployment is unavailable THEN the gateway SHALL only fallback to another Claude model (within the same Anthropic protocol family), never to a GPT or third-party model.

### Requirement 6: Model Listing & Alias Resolution

**User Story:** As a developer, I want to call `GET /v1/models` so that I can discover available models and their aliases.

#### Acceptance Criteria

1. WHEN `GET /v1/models` is called THEN the gateway SHALL return a unified list of all available models across Azure deployments in OpenAI format.
2. WHEN a model alias is used in a request (e.g., `claude-opus-4-6`) THEN the gateway SHALL resolve it to the actual Azure deployment name and route to the correct backend (Azure OpenAI for GPT, Azure AI Foundry for all others).
3. WHEN a user's PAT scope restricts model access THEN `GET /v1/models` SHALL only return models the user is authorized to use.
4. WHEN frontier models are available THEN the gateway SHALL include all of them in the model list with metadata indicating their supported protocol (`chat-completions` for GPT/Kimi/GLM/MiniMax, `messages` for Claude models).
5. WHEN a model list entry is for a Claude model THEN it SHALL indicate that the model is only accessible via `POST /v1/messages`.

### Requirement 7: USD-Based Quota Management

**User Story:** As a platform engineer, I want per-user monthly USD budgets enforced in real-time so that no user exceeds their allocated spend.

#### Acceptance Criteria

1. WHEN a request arrives THEN the gateway SHALL estimate the cost using the reservation pattern: estimate 120% of expected cost (input + output + thinking tokens).
2. WHEN the estimated cost plus current spent plus reserved amounts exceeds the user's monthly budget THEN the gateway SHALL reject the request with HTTP 429 and `X-Quota-Remaining: 0`.
3. WHEN the Azure response completes THEN the gateway SHALL reconcile the reservation against actual usage from the Azure `usage` field.
4. WHEN the reservation is reconciled THEN the gateway SHALL refund the unused reservation amount atomically via Redis Lua scripts.
5. WHEN a reservation is orphaned (no response within 5 minutes) THEN the gateway SHALL automatically release the reservation via TTL.
6. WHEN a new month begins THEN the gateway SHALL reset quota counters and archive the previous month's data to PostgreSQL.
7. IF a user has `hard_limit: false` THEN the gateway SHALL allow requests beyond budget (soft limit) but log warnings.
8. WHEN `GET /quota` is called THEN the gateway SHALL return the user's current `monthly_budget_usd`, `spent_usd`, `reserved_usd`, and `remaining_usd`.

### Requirement 8: Pricing & Cost Calculation

**User Story:** As a finance team member, I want accurate per-request cost tracking with support for thinking tokens and cache pricing so that I can reconcile gateway costs against Azure invoices.

#### Acceptance Criteria

1. WHEN a request completes THEN the gateway SHALL calculate cost as: `(input_tokens / 1M * input_rate) + (output_tokens / 1M * output_rate) + (thinking_tokens / 1M * thinking_rate)`.
2. WHEN the Azure response includes a `usage` field THEN the gateway SHALL use it as the authoritative source for token counts (never client-reported counts).
3. WHEN a request errors or times out with no `usage` field THEN the gateway SHALL treat the cost as $0.
4. WHEN the model supports prompt caching (Claude models) THEN the gateway SHALL apply the cache write/read discount rates when Azure reports cached tokens.
5. WHEN thinking mode is enabled on Claude models THEN the gateway SHALL bill thinking tokens at the model's `thinking_tokens_per_million` rate.
6. WHEN `config/pricing.json` is modified THEN the gateway SHALL hot-reload the pricing without restart.
7. WHEN calculating costs THEN the gateway SHALL use `decimal.js` with 6 decimal places to avoid floating-point errors.

### Requirement 9: Routing & Resilience

**User Story:** As a developer, I want the gateway to automatically handle failures and route to fallback models so that my requests succeed even when a deployment is unhealthy.

#### Acceptance Criteria

1. WHEN a deployment fails 5 consecutive times THEN the circuit breaker SHALL open and route traffic to the configured fallback model within the same protocol family only.
2. WHEN the circuit breaker is open for 30 seconds THEN it SHALL transition to half-open and attempt one probe request.
3. WHEN a retryable error occurs (5xx, timeout) THEN the gateway SHALL retry with exponential backoff (1s, 2s, 4s, 8s, max 30s) with +/-1s jitter.
4. WHEN Azure returns a `Retry-After` header THEN the gateway SHALL respect that value instead of the default backoff.
5. WHEN the error is non-retryable (400, 401, 403) THEN the gateway SHALL NOT retry and return the error immediately.
6. WHEN a Claude model fails THEN the gateway SHALL only fallback to another Claude model (e.g., Claude Opus -> Claude Sonnet), never to a GPT or third-party model (no cross-protocol fallback).
7. WHEN a Chat Completions-compatible model fails (GPT, Kimi, GLM, MiniMax) THEN the gateway MAY fallback to another Chat Completions-compatible model.
8. WHEN health checks run every 30 seconds per deployment THEN the gateway SHALL mark unhealthy deployments and exclude them from routing.

### Requirement 10: Rate Limiting

**User Story:** As a platform engineer, I want per-user and per-deployment rate limits so that no single user or model monopolizes resources.

#### Acceptance Criteria

1. WHEN a user exceeds 100 requests/minute THEN the gateway SHALL return HTTP 429 with `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers.
2. WHEN a user exceeds 100,000 tokens/minute THEN the gateway SHALL return HTTP 429.
3. WHEN Azure reports TPM/RPM limits for a deployment THEN the gateway SHALL respect those limits and queue or reject requests accordingly.
4. WHEN rate limit headers are set THEN they SHALL include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.

### Requirement 11: Token Estimation

**User Story:** As a gateway operator, I want accurate pre-request token estimation so that quota reservations are close to actual usage.

#### Acceptance Criteria

1. WHEN estimating tokens for OpenAI models THEN the gateway SHALL use tiktoken with `cl100k_base` encoding.
2. WHEN estimating tokens for Claude models THEN the gateway SHALL apply a 1.1x multiplier over the OpenAI token count (different tokenizer).
3. WHEN thinking mode is enabled THEN the gateway SHALL add a 20% buffer to the thinking token estimate.
4. IF tiktoken fails or is unavailable THEN the gateway SHALL fall back to 4 characters per token + 100 overhead.

### Requirement 12: Observability

**User Story:** As an SRE, I want comprehensive tracing, metrics, and structured logging so that I can monitor gateway health and debug issues.

#### Acceptance Criteria

1. WHEN a request is processed THEN the gateway SHALL create an OpenTelemetry span with attributes: `llm.user_id`, `llm.model`, `llm.deployment`, `llm.tokens.input`, `llm.tokens.output`, `llm.tokens.thinking`, `llm.cost.usd`, `llm.protocol`, `azure.auth_type`.
2. WHEN proxying to Azure THEN the gateway SHALL propagate the trace ID via `x-ms-client-request-id` header.
3. WHEN a request completes THEN the gateway SHALL emit a structured JSON log with timestamp, trace_id, user_id, model, tokens, cost, duration, and status.
4. WHEN errors occur THEN the gateway SHALL sample at 100%; for successful requests, sample at 10%.
5. WHEN metrics are collected THEN the gateway SHALL expose: `http_requests_total`, `llm_tokens_total`, `llm_cost_usd_total`, `llm_quota_remaining_ratio`, `circuit_breaker_state`, and `azure_rate_limit_hits_total`.

### Requirement 13: Health & Readiness

**User Story:** As a DevOps engineer, I want health and readiness endpoints so that load balancers and orchestrators can manage gateway instances.

#### Acceptance Criteria

1. WHEN `GET /health` is called THEN the gateway SHALL return `{"status": "healthy", "version": "...", "timestamp": "..."}` with HTTP 200.
2. WHEN `GET /ready` is called THEN the gateway SHALL verify Redis and Azure connectivity and return HTTP 200 only if all dependencies are reachable.
3. WHEN the gateway receives SIGTERM THEN it SHALL gracefully drain in-flight requests with a 30-second timeout before shutting down.

### Requirement 14: Admin API

**User Story:** As a platform admin, I want an admin endpoint to immediately revoke compromised PATs so that security incidents are contained within seconds.

#### Acceptance Criteria

1. WHEN `POST /admin/pat/revoke` is called with `{ pat_id, reason }` THEN the gateway SHALL add the token to the Redis blocklist with a TTL matching the token's remaining lifetime.
2. WHEN a PAT is revoked THEN the gateway SHALL log the revocation to the `pat_revocation_log` PostgreSQL table with `revoked_by`, `revoked_at`, and `reason`.
3. WHEN the revocation completes THEN the gateway SHALL return `{ success: true, revoked_at, message }`.
4. WHEN a revoked token is used in subsequent requests THEN the gateway SHALL reject it within 1 second of the revocation call.

### Requirement 15: Data Persistence

**User Story:** As a platform engineer, I want usage data persisted to PostgreSQL so that I have audit trails and historical usage analytics.

#### Acceptance Criteria

1. WHEN a request completes THEN the gateway SHALL insert a record into `request_audit` with user_id, model, deployment, tokens (input/output/thinking), cost, duration, and status.
2. WHEN a month ends THEN the gateway SHALL archive quota data from Redis to the `usage_history` PostgreSQL table.
3. WHEN a PAT is created THEN the gateway SHALL store its HMAC hash (never the raw token) in the `api_keys` table.
4. WHEN a user is created or updated THEN the gateway SHALL store the record in the `users` table with `monthly_budget_usd`, `hard_limit`, and `rate_limit_tier`.

### Requirement 16: HTTP Test Files

**User Story:** As a developer, I want `.http` test files for every gateway endpoint so that I can quickly validate endpoints from my IDE or CI pipeline.

#### Acceptance Criteria

1. WHEN the project is set up THEN there SHALL be `.http` files covering all public endpoints: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/models`, `/health`, `/ready`, `/quota`, and `/admin/pat/revoke`.
2. WHEN a `.http` file is opened in an IDE (VS Code REST Client, JetBrains HTTP Client) THEN it SHALL be immediately executable with configurable environment variables for `{{host}}` and `{{token}}`.
3. WHEN testing streaming endpoints THEN the `.http` files SHALL include both streaming (`stream: true`) and non-streaming variants.
4. WHEN testing the Anthropic endpoint THEN the `.http` files SHALL include a thinking mode request variant.
5. WHEN testing error scenarios THEN the `.http` files SHALL include requests for 401 (bad token), 429 (rate limit), and 400 (malformed request).

### Requirement 17: Performance

**User Story:** As a platform engineer, I want the gateway to add minimal latency overhead so that developers don't experience degraded performance.

#### Acceptance Criteria

1. WHEN processing a request THEN the gateway overhead (excluding Azure latency) SHALL be < 50ms at P50 and < 100ms at P99.
2. WHEN handling concurrent streams THEN the gateway SHALL support at least 1,000 concurrent streaming connections per instance.
3. WHEN the gateway starts THEN it SHALL warm HTTP/2 connections to Azure endpoints (10-50 persistent connections per endpoint).
4. WHEN streaming responses THEN the gateway SHALL use zero-copy streaming via TransformStream without buffering the full response.

### Requirement 18: Security

**User Story:** As a security engineer, I want the gateway to follow security best practices so that credentials and user data are protected.

#### Acceptance Criteria

1. WHEN connections are established THEN the gateway SHALL use TLS 1.3 for all external connections.
2. WHEN logging requests THEN the gateway SHALL NOT log message content, only metadata (model, tokens, cost, duration).
3. WHEN storing PATs THEN the gateway SHALL store only the HMAC hash (irreversible).
4. WHEN storing Azure API keys THEN the gateway SHALL read them from environment variables or Azure Key Vault, never from code or config files.
5. WHEN request/response data is logged THEN the gateway SHALL sanitize PII from log entries.
