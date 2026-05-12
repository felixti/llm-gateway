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

| Deployment Name | Model Alias | Protocol | Deployment Type | Fallback |
|-----------------|-------------|----------|-----------------|----------|
| gpt-5-mini | gpt-5-mini | OpenAI Chat Completions | Azure OpenAI | → gpt-5.3-codex |
| gpt-5.4-global | gpt-5.4 | OpenAI Chat Completions | Azure OpenAI | → gpt-5.3-codex |
| gpt-5.3-codex | gpt-5.3-codex | OpenAI Chat Completions | Azure OpenAI | — |
| claude-opus-4-6 | claude-opus-4-6 | Anthropic Messages | Azure AI Foundry | → claude-sonnet-4-6 |
| claude-sonnet-4-6 | claude-sonnet-4-6 | Anthropic Messages | Azure AI Foundry | → claude-haiku-4-5 |
| claude-haiku-4-5 | claude-haiku-4-5 | Anthropic Messages | Azure AI Foundry | — |
| kimi-k2.5 | kimi-k2.5 | OpenAI Chat Completions | Azure AI Foundry | — |
| glm-5 | glm-5 | OpenAI Chat Completions | Azure AI Foundry | — |
| minimax-m2.5 | minimax-m2.5 | OpenAI Chat Completions | Azure AI Foundry | — |

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
- PII sanitization in logs (email patterns, token prefixes) via `sanitize-pii.ts` and `pino-pii-transport.ts`
- Never log message content - only metadata

### Background Jobs (scheduler.service.ts)
Three background jobs run on intervals with distributed Redis locks:
1. **Orphan Cleanup** (5 min) — Removes expired quota reservations, releases reserved amounts
2. **Monthly Archive** (1 hr) — Archives prior-month Redis quota data into PostgreSQL `usage_history`
3. **Quota Reconciler** (1 min, configurable via `RECONCILER_INTERVAL_MS`) — Rebuilds Redis `spent` from PostgreSQL audit logs

### Write-Ahead Log (wal.service.ts)
Disk-based DLQ for unbilled requests when both Redis and PostgreSQL fail simultaneously:
- **Directory**: Configurable via `WAL_DIR` (default: `/var/lib/llm-gateway/dlq`)
- **Security**: WAL files created with `0o600` permissions inside `0o700` directory
- **Recovery**: `wal-replayer.service.ts` drains entries to PostgreSQL on configurable interval

### Operations Docs
- Runbooks: `docs/operations/` (PAT rotation, operator secret rotation, quota drift, migrations, observability/SLOs)
- Migrations: `migrations/` at project root (not under `src/`)

---

## Directory Structure

```
src/
├── index.ts                 # Bun.serve bootstrap, graceful shutdown, starts all workers
├── app.ts                   # Hono app factory: global middleware + routes + error handler
├── types.ts                 # Shared TypeScript type definitions
├── config/
│   ├── index.ts             # Barrel re-exports
│   ├── env.ts               # Zod environment validation (lazy singleton)
│   ├── deployments.ts       # 9 deployment registry + alias/fallback resolution
│   └── pricing.json         # Model pricing per-million tokens (hot-reload via watcher)
├── middleware/
│   ├── request-id.ts        # UUID generation, X-Request-Id header
│   ├── auth.ts              # PAT authentication (HMAC-SHA256)
│   ├── scope.ts             # Scope enforcement (all/read/admin/models:<name>)
│   ├── admin-scope.ts       # Admin scope + optional X-Operator-Secret check
│   ├── protocol-guard.ts    # Model-endpoint compatibility validation
│   ├── rate-limit.ts        # Redis RPM/TPM rate limiting (fail-closed)
│   ├── quota.ts             # Quota estimation, reservation, release on abort
│   ├── cache.ts             # Redis-backed response caching (GET endpoints)
│   ├── performance.ts       # Request duration histogram + counter
│   └── timeout.ts           # AbortSignal-based request timeout
├── services/
│   ├── azure-auth.ts        # Entra ID (OAuth2 client creds) + API Key auth manager
│   ├── circuit-breaker.ts   # Per-deployment circuit breaker (Redis-backed)
│   ├── retry.ts             # Exponential backoff with jitter (skip 400/401/403)
│   ├── pricing.service.ts   # Cost calculation (Decimal.js 6dp), pricing watcher
│   ├── quota.service.ts     # Quota reserve/reconcile/release, orphan cleanup, top-up
│   ├── health.service.ts    # Non-billing health probes with in-memory cache
│   ├── scheduler.service.ts # Background jobs: orphan cleanup, archive, reconciler
│   ├── shutdown.service.ts  # In-flight request tracking, graceful drain
│   ├── wal.service.ts       # Write-Ahead Log for unbilled requests (disk DLQ)
│   ├── wal-replayer.service.ts # WAL replay to PostgreSQL (background job)
│   └── quota/
│       ├── constants.ts     # Key prefixes, TTLs, default budget
│       ├── keys.ts          # Redis key generation helpers
│       ├── money.ts         # Microdollars conversion (Decimal → micro integer)
│       ├── policy.ts        # Postgres → Redis quota policy sync
│       └── scripts.ts       # Redis Lua scripts (reserve, release, reconcile, cleanup, top-up)
├── proxy/
│   ├── openai-chat.proxy.ts     # GPT/Kimi/GLM/MiniMax Chat Completions proxy
│   ├── anthropic.proxy.ts       # Claude Messages API proxy + count_tokens
│   ├── openai-responses.proxy.ts # OpenAI Responses API proxy
│   ├── responses-tools.ts       # Tool normalization for Responses API
│   └── shared.ts                # Quota release, audit logging, WAL fallback, error sanitization
├── routes/
│   ├── chat.routes.ts       # POST /v1/chat/completions
│   ├── messages.routes.ts   # POST /v1/messages, POST /v1/messages/count_tokens
│   ├── responses.routes.ts  # POST /v1/responses
│   ├── models.routes.ts     # GET /v1/models (with response cache, PAT-scope filtering)
│   ├── health.routes.ts     # GET /health, /ready, /metrics, /openapi.json, /docs
│   ├── quota.routes.ts      # GET /quota
│   ├── admin.routes.ts      # POST /admin/pat/revoke
│   └── factories/
│       ├── request-handler.factory.ts # Handler factory with fallback chain support
│       ├── errors.ts                  # Protocol-aware error response builders
│       └── types.ts                   # ProxyRequestContext, handler deps types
├── utils/
│   ├── errors.ts        # Protocol-aware error factories (OpenAI vs Anthropic)
│   ├── tokens.ts        # Token estimation (tiktoken cl100k_base)
│   ├── streaming.ts     # SSE TransformStreams, usage extraction
│   ├── auth.ts          # PAT structure validation, JTI hashing
│   ├── result.ts        # Either monad (ok/err/isOk/isErr)
│   ├── fetch.ts         # HTTPS-only upstream fetch wrapper
│   ├── functional.ts    # compose, pipe, curry, throttle, partial
│   ├── model-scope.ts   # Model-scoped PAT validation (models:<name>)
│   └── mutex.ts         # Async mutex for critical sections
├── observability/
│   ├── tracing.ts           # OpenTelemetry SDK (OTLP gRPC), custom span attributes
│   ├── logger.ts            # Pino structured JSON logging + request log helpers
│   ├── metrics.ts           # Prometheus counters/gauges/histograms
│   ├── sanitize-pii.ts      # PII sanitization (email, token prefixes)
│   ├── pino-pii-transport.ts # Pino stream that redacts PII
│   └── otlp-http-url.ts     # OTLP HTTP endpoint URL parsing
├── db/
│   ├── client.ts        # PostgreSQL via postgres.js (pool 20, idle 30s)
│   ├── redis.ts         # Redis via ioredis (lazy connect in test)
│   └── data-access.ts   # Audit logging, user resolution, batch archive/stats
migrations/                  # PostgreSQL schema migrations (project root)
├── 000_migration_tracking.sql
├── 001_initial_schema.sql
├── 002_pat_subject.sql
├── 003_request_audit_monthly_range.sql
└── 004_check_constraints.sql
```

---

## Testing Requirements

### Unit Tests (63 files in `tests/unit/`)
- Config validation (`config/env.test.ts`, `config/deployments.test.ts`)
- Deployment registry (alias resolution, family classification, fallback chain)
- Token estimation (`utils/tokens.test.ts`, `utils/tokens.extended.test.ts`)
- Pricing calculations (`services/pricing.service.test.ts`, `services/pricing.service.extended.test.ts`)
- Circuit breaker state transitions (`services/circuit-breaker.test.ts`)
- Circuit breaker probe TTL (`services/circuit-breaker-probe-ttl.test.ts`)
- Retry backoff timing (`services/retry.test.ts`)
- PAT authentication (valid/expired/invalid/revoked) (`middleware/auth.test.ts`)
- Protocol guard (model-endpoint combinations) (`middleware/protocol-guard.test.ts`)
- Scope enforcement (`middleware/scope.test.ts`)
- Admin scope guard (`middleware/admin-scope.test.ts`)
- Cache middleware (`middleware/cache.test.ts`)
- Timeout middleware (`middleware/timeout.test.ts`)
- Quota middleware (`middleware/quota.test.ts`)
- Rate limiting (`middleware/rate-limit.test.ts`)
- Error factories (all code mappings) (`utils/errors.test.ts`)
- Result/Either monad (`utils/result.test.ts`, `utils/result-full.test.ts`)
- Streaming SSE (`utils/streaming.test.ts`)
- Functional utilities (`utils/functional.test.ts`)
- Async mutex (`utils/mutex.test.ts`)
- Auth utilities (`utils/auth.test.ts`)
- HTTPS fetch (`utils/fetch.test.ts`)
- Azure auth manager (`services/azure-auth.test.ts`)
- Health service (`services/health.service.test.ts`, `services/health.service.extended.test.ts`)
- Scheduler service (`services/scheduler.service.test.ts`, `services/scheduler.service.extended.test.ts`)
- Shutdown service (`services/shutdown.service.test.ts`, `services/shutdown.service.extended.test.ts`)
- WAL service (`services/wal.service.test.ts`)
- WAL replayer (`services/wal-replayer.service.test.ts`)
- Quota Lua scripts (`services/quota-lua-prefix-alignment.test.ts`)
- Quota atomic operations (`services/quota-atomic-operations.test.ts`)
- Quota concurrency (`services/quota-concurrency.test.ts`)
- Quota orphan cleanup (`services/quota-orphan-cleanup.test.ts`)
- Quota top-up (`services/quota-topup.test.ts`)
- Quota service (`services/quota.service.test.ts`, `services/quota.service.extended.test.ts`)
- Proxy implementations (`proxy/openai-chat.proxy.test.ts`, `proxy/anthropic.proxy.test.ts`, `proxy/openai-responses.proxy.test.ts`, `proxy/shared.test.ts`)
- Request handler factory (`routes/factories/request-handler.factory.test.ts`)
- Route handlers (`routes/chat.test.ts`, `routes/health.routes.test.ts`, `routes/quota.routes.test.ts`)
- Observability (`observability/logger.test.ts`, `observability/tracing.test.ts`, `observability/metrics.test.ts`, `observability/otlp-http-url.test.ts`, `observability/pino-pii-transport.test.ts`)
- Security (`security/sanitization.test.ts`, `security/gitignore.test.ts`, `security/pat-contract-doc.test.ts`)
- App bootstrap (`app.test.ts`)
- Database (`db/resolve-user-id.test.ts`)

### Integration Tests (11 files in `tests/integration/`)
- PostgreSQL data access (`db/data-access.test.ts`, `db/audit-stats-batch.test.ts`)
- Redis: reserve, reconcile, release, orphan cleanup
- Quota middleware: hard limit → 429, soft limit → warn
- Health/readiness endpoints (`routes/health.test.ts`)
- Route integration: chat, messages, responses, models, quota, admin
- Observability synthetic (`observability/synthetic.test.ts`)
- Redis-down chaos (`proxy/redis-down-chaos.test.ts`)

### Chaos Tests (4 files in `tests/chaos/`)
- PostgreSQL failure (`postgres-failure.test.ts`)
- Redis failure (`redis-failure.test.ts`)
- Network partition (`network-partition.test.ts`)
- Partial commit (`partial-commit.test.ts`)

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

### Global Middleware (in app.ts)

Applied to **all routes** via `app.use('*', ...)`:
```
1. compress()            - Response compression (gzip/brotli, skips SSE)
2. secureHeaders()       - Security headers (HSTS, X-Frame-Options, etc.)
3. cors()                - CORS handling (configurable origins)
4. requestIdMiddleware   - Sets 'requestId' (UUID), adds X-Request-Id header
5. shutdownMiddleware    - Tracks in-flight requests, rejects with 503 during shutdown
6. timeoutMiddleware     - Sets 'requestSignal' (AbortSignal), enforces REQUEST_TIMEOUT_MS
7. performanceMiddleware - Records request duration histogram + counter
```

### Per-Route Middleware Chain

**API Routes** (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`):
```
authMiddleware → scopeMiddleware → protocolGuardMiddleware → rateLimitMiddleware → quotaMiddleware → [Handler]
```

**Models Route** (`/v1/models`):
```
authMiddleware → scopeMiddleware → cacheMiddleware(ttl: 300) → [Handler]
```

**Quota Route** (`/quota`):
```
authMiddleware → scopeMiddleware → [Handler]
```

**Admin Routes** (`/admin`):
```
authMiddleware → requireAdminScopeMiddleware → [Handler]
```

**Health/Observability** (`/health`, `/ready`, `/metrics`, `/openapi.json`, `/docs`):
```
(none — no auth required)
```

### Context Variables Set by Each Middleware

| Middleware | Variables Set |
|-----------|---------------|
| `requestIdMiddleware` | `requestId` (UUID) |
| `authMiddleware` | `userId`, `scope`, `jti`, `patToken` |
| `protocolGuardMiddleware` | `model`, `modelFamily`, `parsedBody` |
| `quotaMiddleware` | `reservationId`, `estimatedCost`, `model`, `releaseQuota` |
| `timeoutMiddleware` | `requestSignal` (AbortSignal) |

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

### Application
- `NODE_ENV` - Runtime mode: `development`, `production`, `test` (default: `development`)
- `PORT` - Server port (default: `3000`)
- `LOG_LEVEL` - Log verbosity: `fatal`, `error`, `warn`, `info`, `debug`, `trace` (default: `info`)
- `DOCS_ENABLED` - Expose `/docs` (Scalar) and `/openapi.json` (default: `false`)

### Azure Authentication
- `AZURE_OPENAI_ENDPOINT` - Azure OpenAI endpoint URL (HTTPS required in production)
- `AZURE_OPENAI_KEY` - Azure OpenAI API key (or use Entra ID credentials)
- `AZURE_AI_FOUNDRY_ENDPOINT` - Azure AI Foundry endpoint URL (HTTPS required in production)
- `AZURE_AI_FOUNDRY_KEY` - Azure AI Foundry API key (or use Entra ID credentials)
- `AZURE_ENTRA_TENANT_ID` - Entra ID tenant UUID (for OAuth2 client credentials)
- `AZURE_ENTRA_CLIENT_ID` - Entra ID client UUID
- `AZURE_ENTRA_CLIENT_SECRET` - Entra ID client secret

### Storage
- `REDIS_URL` - Full Redis URL (alternative to HOST/PORT/PASSWORD)
- `REDIS_HOST` - Redis host (default: `localhost`; must be explicit in production)
- `REDIS_PORT` - Redis port (default: `6379`)
- `REDIS_PASSWORD` - Redis password
- `DATABASE_URL` - PostgreSQL connection string (default: `postgresql://postgres:postgres@localhost:5432/llm_gateway`; must be explicit in production)

### Security
- `PAT_SECRET` - HMAC-SHA256 signing key for PAT tokens (min 32 characters, **required**)
- `ADMIN_OPERATOR_SECRET` - Optional shared secret for `/admin` routes (header `X-Operator-Secret`; min 16 chars)
- `CORS_ALLOWED_ORIGINS` - Comma-separated allowed origins (default: `*`; must list explicit origins in production)
- `BODY_SIZE_LIMIT_BYTES` - Max request body size (default: `10485760` / 10MB)
- `REQUEST_TIMEOUT_MS` - Request timeout (default: `30000` / 30s)
- `SHUTDOWN_TIMEOUT_MS` - Graceful shutdown timeout (default: `30000` / 30s)

### Rate Limiting
- `RATE_LIMIT_RPM` - Requests per minute per user (default: `100`)
- `RATE_LIMIT_TPM` - Tokens per minute per user (default: `100000`)

### Quota
- `QUOTA_RESERVATION_TTL_SECONDS` - Reservation TTL (default: `300`)
- `QUOTA_IDEMPOTENCY_TTL_SECONDS` - Idempotency key TTL (default: `604800` / 7 days)
- `QUOTA_MULTIPLIER` - Reservation multiplier (default: `1.2`)
- `QUOTA_SOFT_LIMIT_ENABLED` - Soft limit mode (default: `false`)

### Health Checks
- `HEALTH_CHECK_ENABLED` - Enable periodic health checks (default: `true`)
- `HEALTH_CHECK_INTERVAL_MS` - Health check interval (default: `30000`)
- `HEALTH_CHECK_TIMEOUT_MS` - Health check timeout (default: `5000`)
- `HEALTH_CHECK_DEPLOYMENTS_ENABLED` - Enable deployment health probes (default: `true`)
- `HEALTH_CHECK_OTEL_ENABLED` - Report health check results to OTel (default: `true`)

### Observability
- `OTEL_ENABLED` - Enable OpenTelemetry tracing (default: `false`)
- `OTEL_EXPORTER_OTLP_GRPC_ENDPOINT` - OpenTelemetry gRPC endpoint URL
- `OTEL_EXPORTER_OTLP_ENDPOINT` - OpenTelemetry HTTP endpoint URL (alternative to gRPC)
- `OTEL_SERVICE_NAME` - OpenTelemetry service name (default: `llm-gateway`)
- `OTEL_TRACING_SAMPLER_RATIO` - Trace sampling ratio 0–1 (default: `0.1`)
- `METRICS_SCRAPE_BEARER` - Bearer token for `/metrics` endpoint (optional)

### Operations
- `WAL_DIR` - Write-Ahead Log directory for dual-failure DLQ (default: `/var/lib/llm-gateway/dlq`)
- `RECONCILER_INTERVAL_MS` - Quota reconciler job interval (default: `60000` / 60s)
- `WAL_REPLAY_INTERVAL_MS` - WAL replayer job interval (default: `60000` / 60s)

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
