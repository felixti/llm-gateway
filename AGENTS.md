# LLM Gateway - Agent Guidelines

## Project Overview

An LLM Gateway API proxy server built in **Bun/Hono** that proxies requests to Azure OpenAI and Azure AI Foundry endpoints. The gateway handles PAT authentication, quota management (USD-based), rate limiting, circuit breaker resilience, streaming, OpenTelemetry observability, and PostgreSQL audit logging.

**Runtime**: Bun (not Node.js)
**Framework**: Hono
**Dependencies**: Redis (rate limiting/quota), PostgreSQL (persistence)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        LLM Gateway                              │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Request  │  │    PAT   │  │ Protocol │  │   Rate   │       │
│  │    ID    │→ │   Auth   │→ │  Guard   │→ │  Limit   │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
│                                                        │        │
│                       ┌──────────┐                     │        │
│                       │   Quota  │←────────────────────────────┘
│                       └──────────┘
│                           │
│         ┌─────────────────┼─────────────────┐
│         ▼                 ▼                 ▼
│  ┌────────────┐   ┌────────────┐   ┌────────────┐
│  │   OpenAI   │   │  Anthropic  │   │  Responses │
│  │    Chat    │   │  Messages   │   │    API     │
│  └────────────┘   └────────────┘   └────────────┘
│         │                 │                 │
│         ▼                 ▼                 ▼
│  ┌────────────┐   ┌────────────┐   ┌────────────┐
│  │  Circuit   │   │   Retry    │   │  Streaming │
│  │  Breaker   │   │  + Backoff │   │  Utilities │
│  └────────────┘   └────────────┘   └────────────┘
│                                                              │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │   Azure OpenAI / AI Foundry │
              └─────────────────────────────┘
```

---

## Supported Models & Protocols

| Model Family | Protocol | Deployment Type |
|--------------|----------|-----------------|
| GPT-4o, GPT-4o-Mini, GPT-5-Codex | OpenAI Chat Completions | Azure OpenAI |
| Claude-3.5-Sonnet, Claude-3.7-Sonnet | Anthropic Messages | Azure AI Foundry |
| Kimi, GLM, MiniMax | OpenAI Chat Completions | Azure AI Foundry |

---

## Key Design Principles

### Code Standards (from `.opencode/context/core/standards/code-quality.md`)

- **Modular**: Single responsibility per module, < 50 lines per function
- **Functional**: Pure functions, immutability, composition over inheritance
- **Explicit dependencies**: Dependency injection, no hidden global state
- **Declarative**: Describe what, not how

### File Naming
- Files: `lowercase-with-dashes.ts`
- Functions: `verbPhrases` (e.g., `getUser`, `validateEmail`)
- Constants: `UPPER_SNAKE_CASE`

### Error Handling
- Protocol-aware errors: `createOpenAIError()`, `createAnthropicError()`
- Use `errorForProtocol(path, status, code, message)` for auto-format selection

---

## Critical Implementation Details

### PAT Authentication
- Format: `lg_{userId}_{header}.{payload}.{signature}`
- Algorithm: HMAC-SHA256
- Scopes: `all` (full LLM API), `read` (GET/HEAD/OPTIONS only), `admin` (LLM API plus `/admin/*`, e.g. PAT revocation). Use dedicated operator credentials for `admin`.
- Revocation: `POST /admin/pat/revoke` body `pat_id` must match the JWT `jti` claim for the blocklist to apply
- Optional env **`ADMIN_OPERATOR_SECRET`**: when set, callers must send matching **`X-Operator-Secret`** (in addition to `scope: admin` PAT).
- Storage: Blocklist in Redis (`blocklist:pat:{hash(jti)}`), no TTL on revoke entries
- Never log raw PAT tokens

### Quota Management
- **Postgres is authoritative** for `monthly_budget_usd` and `hard_limit` (see `users` table, optional `pat_subject` map to PAT user id)
- Policy is **synced into Redis** (`quota:{userId}:{YYYY-MM}` hash) on a short interval for fast enforcement; live **spent/reserved** stay in Redis
- All costs in USD with 6 decimal precision (use `decimal.js`)
- Atomic reservation via Redis Lua scripts
- 120% multiplier for reservation, 300s TTL for orphan cleanup
- Optional soft cap: `QUOTA_SOFT_LIMIT_ENABLED=true` forces warning path on pre-check; per-user **soft** when `users.hard_limit = false` after sync
- In `NODE_ENV=test`, Postgres sync is **skipped** unless `QUOTA_PG_SYNC_IN_TESTS=true` (CI sets this with the Postgres service)

### Token Estimation
- Use `tiktoken` with `cl100k_base` encoding
- Claude models: 1.1x multiplier
- Thinking-enabled requests: +20% buffer
- Fallback: 4 chars/token + 100 overhead

### Resilience
- Circuit breaker: 5 failures → open, 30s reset → half-open, 1 success → closed
- Retry: Exponential backoff 1s, 2s, 4s, 8s (max 30s) with ±1s jitter
- Non-retryable: 400, 401, 403 errors

### Streaming
- OpenAI: Intercept final chunk `usage` field
- Anthropic: Intercept `message_delta` event for `usage`
- Handle client abort → release quota reservation

### Observability
- OpenTelemetry tracing with custom spans: `llm.user_id`, `llm.model`, `llm.tokens.*`, `llm.cost.usd`
- In-process metrics (`metrics.ts`): quota 429s, rate-limit 429s, Postgres hydration failures, PAT revocations — Prometheus text via `getPrometheusMetrics()`
- Structured logging with pino (JSON format)
- Never log message content - only metadata

### Operations Docs
- Runbooks: `docs/operations/` (PAT rotation, operator secret rotation, quota drift, migrations, observability/SLOs)

---

## Directory Structure

```
src/
├── config/
│   ├── env.ts           # Zod environment validation
│   ├── deployments.ts   # Deployment registry
│   └── pricing.json     # Model pricing (hot-reload)
├── middleware/
│   ├── request-id.ts    # UUID generation
│   ├── auth.ts          # PAT authentication
│   ├── admin-scope.ts # Require `admin` scope for operator routes
│   ├── protocol-guard.ts # Model-endpoint validation
│   ├── rate-limit.ts    # Redis rate limiting
│   └── quota.ts         # Quota reservation
├── services/
│   ├── azure-auth.ts    # Entra ID + API Key
│   ├── circuit-breaker.ts
│   ├── retry.ts
│   ├── pricing.service.ts
│   ├── quota.service.ts
│   └── health.service.ts
├── proxy/
│   ├── openai-chat.proxy.ts
│   ├── anthropic.proxy.ts
│   └── openai-responses.proxy.ts
├── routes/
│   ├── chat.routes.ts
│   ├── messages.routes.ts
│   ├── responses.routes.ts
│   ├── models.routes.ts
│   ├── health.routes.ts
│   ├── quota.routes.ts
│   └── admin.routes.ts
├── utils/
│   ├── errors.ts        # Protocol-aware errors
│   ├── tokens.ts        # Token estimation
│   └── streaming.ts     # SSE parsing
├── observability/
│   ├── tracing.ts       # OpenTelemetry
│   ├── logger.ts        # Pino structured logging
│   └── metrics.ts       # Counters/gauges
├── db/
│   ├── migration.sql    # PostgreSQL schema
│   └── data-access.ts   # Audit logging
└── index.ts             # Hono app bootstrap
```

---

## Testing Requirements

### Unit Tests
- Config validation
- Deployment registry (alias resolution, family classification, fallback chain)
- Token estimation
- Pricing calculations
- Circuit breaker state transitions
- Retry backoff timing
- PAT authentication (valid/expired/invalid/revoked)
- Protocol guard (model-endpoint combinations)
- Error factories (all code mappings)

### Integration Tests
- Redis: reserve, reconcile, release, orphan cleanup
- Quota middleware: hard limit → 429, soft limit → warn
- Health/readiness endpoints

### HTTP Test Files
- `http/chat-completions.http`
- `http/messages.http`
- `http/responses.http`
- `http/models.http`
- `http/health.http`
- `http/quota.http`
- `http/admin.http`
- `http/errors.http`

---

## Security Hardening

- Outbound Azure traffic uses `upstreamHttpsFetch` (HTTPS-only URLs; Bun negotiates TLS)
- PAT stored as HMAC hash only (never raw)
- Azure API keys from env vars only
- PII sanitization in logs (email patterns, token prefixes)
- No message content in logs

---

## Context Files Reference

When working on any component, always load:
1. **Standards**: `.opencode/context/core/standards/code-quality.md`
2. **Specs**: 
   - `.context/specs/llm-gateway/requirements.md`
   - `.context/specs/llm-gateway/design.md`
   - `.context/specs/llm-gateway/tasks.md`

---

## Task Files

- Session: `.tmp/sessions/2026-03-20-llm-gateway/context.md`
- Tasks: `.tmp/tasks/llm-gateway/task.json` + `subtask_*.json`

---

## Middleware Chain & Request Flow

### Global Middleware (in index.ts)

Applied to **all routes** via `app.use('*', ...)`:
```
1. secureHeaders()     - Security headers (HSTS, X-Frame-Options, etc.)
2. cors()              - CORS handling
3. requestIdMiddleware - Sets 'requestId' (UUID), adds X-Request-Id header
4. shutdownMiddleware  - Tracks in-flight requests, rejects with 503 during shutdown
5. timeoutMiddleware   - Enforces REQUEST_TIMEOUT_MS, returns 504 on timeout
```

### Per-Route Middleware Chain

**API Routes** (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`):
```
authMiddleware → scopeMiddleware → protocolGuardMiddleware → rateLimitMiddleware → quotaMiddleware → [Handler]
```

**Admin Routes** (`/admin`):
```
authMiddleware → requireAdminScopeMiddleware → [Handler]
```

### Context Variables Set by Each Middleware

| Middleware | Variables Set |
|-----------|---------------|
| `requestIdMiddleware` | `requestId` (UUID) |
| `authMiddleware` | `userId`, `scope`, `jti`, `patToken` |
| `protocolGuardMiddleware` | `model`, `modelFamily`, `parsedBody` |
| `quotaMiddleware` | `reservationId`, `estimatedCost`, `model`, `releaseQuota` |

---

## Key Architectural Patterns

### Result Type Pattern
File: `src/utils/result.ts`
Either monad with `ok()`/`err()` factories, `map`, `flatMap`, `isOk()` guards.
Used in auth middleware for chained validation.

### Protocol-Aware Error Factories
File: `src/utils/errors.ts`
`errorForProtocol()` detects Anthropic vs OpenAI by path prefix (`/v1/messages` = Anthropic).
Returns protocol-appropriate error structure.

### Decimal.js for Financial Calculations
Files: `src/services/pricing.service.ts`, `src/config/pricing.ts`
All USD calculations use Decimal with 6-decimal precision.
Avoids floating-point issues.

### Redis Lua Scripts for Atomic Operations
File: `src/services/quota.service.ts`
`CHECK_AND_RESERVE_SCRIPT` atomically validates budget, increments reserved amount, creates TTL reservation in single Redis round-trip.

### Streaming Interception
Files: `src/utils/streaming.ts`, `src/proxy/*.ts`
TransformStream pipeline that passes chunks through while extracting usage.
OpenAI: looks for `usage` field in final chunk.
Anthropic: looks for `message_delta` event.

### Circuit Breaker State Machine
File: `src/services/circuit-breaker.ts`
States: CLOSED → OPEN (5 failures) → HALF_OPEN (30s timeout) → CLOSED (1 success).
Per-deployment instances stored in Map.

### Graceful Shutdown
File: `src/services/shutdown.service.ts`
Tracks in-flight requests with atomic counter.
Rejects new requests with 503 during shutdown.
Waits for drain with configurable timeout (SHUTDOWN_TIMEOUT_MS).

---

## Performance Optimizations

### Response Compression
- **Implementation**: `hono-compress` middleware in `src/index.ts`
- **Scope**: Applied globally to all routes
- **Benefit**: 60-80% reduction in response payload size
- **Algorithms**: gzip (default) with brotli support where available

### Response Caching
- **Implementation**: `src/middleware/cache.ts` with Redis backing
- **Scope**: Applied to read-only endpoints (e.g., `/v1/models`)
- **Configuration**: Configurable TTL per route (default 60s, models endpoint 300s)
- **Cache Key**: `cache:{method}:{path}` pattern
- **Behavior**: Returns cached JSON on hit, stores 200 responses on miss

### Connection Pooling

#### PostgreSQL
- **File**: `src/db/client.ts`
- **Max connections**: 20 (up from 10)
- **Idle timeout**: 30s (up from 20s)
- **Prepared statements**: Enabled for repeated query optimization

#### Redis
- **File**: `src/db/redis.ts`
- **Lazy connect**: Enabled in test environment
- **Retry strategy**: Exponential backoff (50ms × attempts, max 2000ms)
- **Max retries**: 3 per request
- **Ready check**: Enabled with offline queue

### Performance Monitoring
- **Implementation**: `src/middleware/performance.ts`
- **Metrics tracked**: Request duration via `performance.now()`
- **Export**: Histogram `http_request_duration_ms` with method/path labels
- **Integration**: OpenTelemetry metrics pipeline

### Prometheus Metrics Endpoint
- **Route**: `GET /metrics`
- **Format**: Prometheus text/plain (version 0.0.4)
- **Counters exposed**:
  - `http_requests_total` - Total HTTP requests
  - `llm_tokens_total` - Total LLM tokens processed
  - `llm_cost_usd_total` - Total LLM cost in USD
  - `azure_rate_limit_hits_total` - Azure rate limit encounters
  - `quota_hydration_failures_total` - Postgres sync failures
  - `quota_exceeded_429_total` - Gateway quota rejections
  - `rate_limit_429_total` - Rate limit rejections
  - `pat_revocations_total` - PAT revocation events
- **Gauges**: `llm_quota_remaining_ratio`, `circuit_breaker_state`
- **Histograms**: `http_request_duration_ms`, `llm_request_duration_ms`

### Caching Strategy
- Cache **only** idempotent GET endpoints
- Use short TTLs (60s default) for data that may change
- Use longer TTLs (300s) for relatively static data (models list)
- Skip caching for authenticated user-specific responses

---

## Environment Variables

### Security
- `CORS_ALLOWED_ORIGINS` - Comma-separated allowed origins (default: `*`)
- `BODY_SIZE_LIMIT_BYTES` - Max request body size (default: 10MB)
- `REQUEST_TIMEOUT_MS` - Request timeout (default: 30s)
- `SHUTDOWN_TIMEOUT_MS` - Graceful shutdown timeout (default: 30s)

### Rate Limiting
- `RATE_LIMIT_RPM` - Requests per minute per user (default: 100)
- `RATE_LIMIT_TPM` - Tokens per minute per user (default: 100000)

### Quota
- `QUOTA_RESERVATION_TTL_SECONDS` - Reservation TTL (default: 300)
- `QUOTA_MULTIPLIER` - Reservation multiplier (default: 1.2)
- `QUOTA_SOFT_LIMIT_ENABLED` - Soft limit mode (default: false)

### Health Checks
- `HEALTH_CHECK_ENABLED` - Enable background health checks (default: true)
- `HEALTH_CHECK_INTERVAL_MS` - Health check interval (default: 30000)
- `HEALTH_CHECK_TIMEOUT_MS` - Health check timeout (default: 5000)

---

## Anti-Patterns (THIS PROJECT)

### Security Constraints
- NEVER store raw PAT tokens - always HMAC hash
- NEVER use HTTP for upstream requests - HTTPS only (throws Error)
- NEVER log message content - only metadata
- NEVER allow PAT revocation with `all` or `read` scope - `admin` required
- ALWAYS use timing-safe comparison for HMAC signatures

### Error Handling
- NEVER retry 400, 401, 403 errors - these are non-retryable
- ALWAYS use `errorForProtocol()` for client-facing errors
- NEVER swallow errors silently - log with structured logger

### Quota Management
- Postgres is authoritative for budget policy - Redis is fast path only
- ALWAYS use 120% multiplier for quota reservations
- NEVER skip orphan cleanup - 300s TTL on reservations

### Token Estimation
- ALWAYS apply 1.1x multiplier for Claude models
- ALWAYS apply 1.2x buffer when thinking is enabled
- NEVER use floating-point for USD calculations - use Decimal.js

### Test Environment
- Postgres sync is OFF by default in tests
- Set `QUOTA_PG_SYNC_IN_TESTS=true` to enable
- Use `PAT_SECRET` fallback in test environment
