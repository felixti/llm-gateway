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
