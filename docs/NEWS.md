# What's New in LLM Gateway

> This document tracks major features, improvements, and fixes.
> For detailed architecture, see [architecture.md](architecture.md).
> For operational runbooks, see [operations/](operations/).

---

## May 2026 — Production Hardening & Reliability Release

### New: Write-Ahead Log (WAL) for Unbilled Requests

A disk-based DLQ (dead-letter queue) ensures no request goes unaccounted for when both Redis and PostgreSQL fail simultaneously.

- **File**: `src/services/wal.service.ts`
- **Directory**: Configurable via `WAL_DIR` (default: `/var/lib/llm-gateway/dlq`)
- **Behavior**: When quota reconciliation cannot write to Redis or audit logging fails in PostgreSQL, the gateway writes a WAL entry to disk with request metadata (user, model, tokens, cost, timestamp, failure reason).
- **Security**: WAL files are created with `0o600` permissions inside a `0o700` directory.
- **Recovery**: WAL entries can be replayed once systems recover.

### New: Background Scheduler with Three Jobs

The gateway now runs three background jobs via `src/services/scheduler.service.ts`:

| Job | Interval | Purpose |
|-----|----------|---------|
| **Orphan Cleanup** | 5 min | Removes expired quota reservations (TTL-based) and releases reserved amounts |
| **Monthly Archive** | 1 hour | Archives prior-month Redis quota data into PostgreSQL `usage_history` table |
| **Quota Reconciler** | 1 min (configurable via `RECONCILER_INTERVAL_MS`) | Rebuilds Redis `spent` from PostgreSQL audit logs to detect and correct drift |

All jobs use distributed locking (Redis `SET NX EX`) to prevent duplicate execution across horizontally scaled instances.

### New: Postgres-as-Truth Streaming Reconcile

Quota state in Redis is now continuously reconciled against PostgreSQL audit logs:

- The **reconciler** scans all active user quotas and compares Redis `spent` with the sum of `request_audit.cost_usd`.
- Drift tolerance: 1 micro-dollar.
- If drift is detected, Redis is corrected to match PostgreSQL.
- In `NODE_ENV=test`, Postgres sync is skipped unless `QUOTA_PG_SYNC_IN_TESTS=true`.

### New: Atomic Fallback Reservation Top-Up

When a deployment's circuit breaker triggers failover to a fallback model, the gateway automatically top-ups the quota reservation if the fallback model has different pricing:

- **File**: `src/services/quota.service.ts` (`topUpReservation`)
- **Modes**: `within_budget` | `soft_overage` | `hard_rejected` | `not_found` | `error`
- If soft-limit users exceed their budget during fallback, the request is allowed but tracked via `fallback_soft_overage_total` metric.

### Improved: Non-Billing Health Checks

Health probes no longer trigger billable LLM calls. Instead, they use zero-cost Azure endpoints:

- **Azure OpenAI (GPT)**: `GET /openai/deployments/{name}` — returns deployment metadata
- **Azure AI Foundry**: `GET /models` — returns model listing

This eliminates token costs from Kubernetes liveness/readiness probes.

### Improved: Rate Limiting — Fail-Closed & Burst Protection

- **Fail-closed**: If Redis is unreachable, rate limit checks return "denied" rather than allowing unlimited traffic.
- **Burst undercounting fixed**: Redis sorted-set members now include unique suffixes to prevent duplicate entry suppression within the same millisecond.

### Improved: Circuit Breaker Reliability

- Added `EX` TTL safety net to half-open probe keys to prevent stranded keys.
- Upstream network failures are now caught and recorded as circuit breaker failures, enabling automatic fallback chain activation.

### Improved: PAT Revocation — Permanent Blocklist

- Revoked PATs are stored in Redis with **no TTL** — compromised tokens remain blocked indefinitely.
- Blocklist keys use `hash(jti)` — only the JWT ID is stored, never the raw token.
- **Fail-closed**: If Redis blocklist lookup fails, the request is rejected with 503 (not silently accepted).

### New: Model-Scoped PAT Tokens

PATs now support model-restricted scopes:

```
models:gpt-5.4        → access only to gpt-5.4
models:claude-sonnet-4-6 → access only to claude-sonnet-4-6
```

The models endpoint (`GET /v1/models`) filters the list based on the PAT scope.

### New: Admin Operator Secret (Defense in Depth)

When `ADMIN_OPERATOR_SECRET` is configured, admin endpoints require both:
1. A PAT with `scope: admin`
2. The `X-Operator-Secret` header matching the configured secret

The secret supports live rotation — changes to `ADMIN_OPERATOR_SECRET` are picked up without restart (with a 16-character minimum validation).

### New: Response Caching

GET endpoints support Redis-backed response caching:

- **Models list** (`GET /v1/models`): Cached for 300 seconds, scoped by user + PAT scope
- **Cache key**: `response-cache:{userId}:{method}:{path}{query}`
- **Vary header**: Automatically includes `Authorization` to prevent cross-user cache leaks

### New: Performance Metrics Middleware

All requests are tracked for duration via `performanceMiddleware`:

- Histogram: `http_request_duration_ms` with method/path labels
- Counter: `http_requests_total` with method, normalized path, and status

### New: Comprehensive Prometheus Metrics Endpoint

`GET /metrics` exposes Prometheus-compatible metrics (text/plain, version 0.0.4):

**Counters:**
- `http_requests_total`
- `llm_tokens_total` (input/output by model family)
- `llm_cost_usd_total`
- `quota_exceeded_429_total`
- `rate_limit_429_total`
- `pat_revocations_total`
- `quota_orphan_cleaned_total`
- `unbilled_requests_total` (with reason label: `redis_fail`, `pg_fail`, `both_fail`)
- `fallback_soft_overage_total`

**Gauges:**
- `llm_quota_remaining_ratio` (0-1)
- `circuit_breaker_state` (0=CLOSED, 1=OPEN, 2=HALF_OPEN)

**Histograms:**
- `http_request_duration_ms`
- `llm_request_duration_ms`

Protected by optional bearer token (`METRICS_SCRAPE_BEARER`).

### New: Scalar Interactive API Documentation

Visit `/docs` for interactive API documentation powered by Scalar:
- Request/response examples
- Authentication testing
- OpenAPI 3.1 schema visualization
- Dark/light theme support

### Improved: Security Headers & CORS

- Production-mode validation enforces explicit CORS origins (no `*` wildcard)
- Azure endpoints must use HTTPS in production
- Default database and localhost Redis are rejected in production

### Security: Dependency Audit & Updates

See [security/audit-report-2026-05-03.md](security/audit-report-2026-05-03.md) for full details.

| Package | Before | After | Severity |
|---------|--------|-------|----------|
| `hono` | 4.12.8 | 4.12.16 | Moderate (6 CVEs) |
| `uuid` | 9.0.1 | 14.0.0 | Moderate |
| `protobufjs` | 7.5.4 | 7.5.6 | **Critical** |
| `testcontainers` | 10.28.0 | 11.14.0 | High (dev only) |

Result: **13 → 1 vulnerability** (1 residual moderate in dev dependency, no production exposure).

### New: Observability Dashboards

- **Grafana dashboard**: `docs/operations/grafana-dashboard.json`
- **Prometheus alerts**: `docs/operations/prometheus-alerts.yml`

### New: Count Tokens Endpoint

Anthropic-compatible token counting:

```bash
POST /v1/messages/count_tokens
# or
POST /count_tokens
```

Accepts Anthropic Messages format, returns estimated token count (exempt from quota reservation).

### Improved: Soft Limit Mode

Set `QUOTA_SOFT_LIMIT_ENABLED=true` to enable soft-limit behavior:
- Pre-check adds `X-Warning` header instead of returning 429
- Reservation may still fail if hard budget is truly exhausted
- Usage is still tracked and recorded

### Improved: Production Environment Validation

Zod schema now validates production configuration strictly:
- `CORS_ALLOWED_ORIGINS` must list explicit origins (no `*`)
- Azure endpoints must be HTTPS URLs
- `DATABASE_URL` and `REDIS_HOST` must be explicitly configured (not defaults)
- Either Entra ID credentials or API keys must be provided for both Azure OpenAI and AI Foundry

---

## April 2026 — Core Gateway Release

### Features

- **Multi-protocol support**: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses API
- **9 model deployments**: GPT-5.4, GPT-5-mini, GPT-5.3-Codex, Claude Opus/Sonnet/Haiku 4.5/4.6, Kimi K2.5, GLM-5, MiniMax M2.5
- **PAT authentication**: HMAC-SHA256 with Redis blocklist revocation
- **USD-based quota**: Atomic Redis Lua scripts with 120% reservation multiplier
- **Rate limiting**: Per-user RPM/TPM via Redis sorted sets
- **Circuit breaker**: 5 failures → OPEN, 30s reset, distributed Redis state
- **Retry logic**: Exponential backoff 1s, 2s, 4s, 8s with ±1s jitter
- **Streaming**: Real-time usage extraction from SSE streams (OpenAI + Anthropic)
- **OpenTelemetry**: Traces, metrics, and structured JSON logging
- **Graceful shutdown**: 30s drain timeout with 503 rejection of new requests

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI Chat Completions |
| `/v1/messages` | POST | Anthropic Messages |
| `/v1/messages/count_tokens` | POST | Token counting |
| `/v1/responses` | POST | OpenAI Responses API (partial) |
| `/v1/models` | GET | Available models |
| `/health` | GET | Liveness probe |
| `/ready` | GET | Readiness probe |
| `/metrics` | GET | Prometheus metrics |
| `/docs` | GET | Scalar API docs |
| `/openapi.json` | GET | OpenAPI spec |
| `/quota` | GET | Quota status |
| `/admin/pat/revoke` | POST | PAT revocation (admin only) |

---

## Documentation Index

| Document | Description |
|----------|-------------|
| [architecture.md](architecture.md) | System architecture, request flow, state machines |
| [deployment.md](deployment.md) | Deployment guide, Docker, Kubernetes |
| [operations.md](operations.md) | Operational runbooks |
| [operations/runbook-pat-rotation.md](operations/runbook-pat-rotation.md) | PAT secret rotation |
| [operations/runbook-operator-secret.md](operations/runbook-operator-secret.md) | Operator secret rotation |
| [operations/runbook-quota-drift.md](operations/runbook-quota-drift.md) | Quota drift recovery |
| [operations/observability.md](operations/observability.md) | Monitoring and alerting |
| [security/pat-contract.md](security/pat-contract.md) | PAT token format and security contract |
| [security/audit-report-2026-05-03.md](security/audit-report-2026-05-03.md) | Security audit results |
| [api/responses-api.md](api/responses-api.md) | Responses API compatibility notes |
| [llm-gateway-prd.md](llm-gateway-prd.md) | Product requirements document |
| [llm-gateway-playbook.md](llm-gateway-playbook.md) | Implementation playbook |
