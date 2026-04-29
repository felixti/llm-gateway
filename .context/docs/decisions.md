# Architecture Decisions

## 2026-04-29 — Scope Extraction Bug Fix

**Decision:** Fixed `parseJwtPayload` in `src/middleware/auth.ts` to extract `scope` from JWT payload.

**Context:** The auth middleware's `parseJwtPayload` function decoded the PAT payload but only extracted `jti` and `exp`, omitting `scope`. This caused `c.set(SCOPE_KEY, payload.scope || 'all')` to always default to `'all'`, completely bypassing scope enforcement.

**Impact:** Write-only PATs could perform read operations, and read-only PATs could perform write operations. This was a security bug.

**Fix:** Added `scope` extraction to `parseJwtPayload`:
```typescript
const decoded = JSON.parse(atob(padded)) as { jti?: string; exp?: number; scope?: string };
// ...
return ok({ jti, exp, scope }) as AuthResult<JwtPayload>;
```

## 2026-04-29 — MockRedis `set` Method Addition

**Decision:** Added `set(key, value, ...args)` to MockRedis to support ioredis's `redis.set(key, value, 'EX', seconds)` API.

**Context:** `admin.routes.ts` uses `redis.set(blocklistKey, '1', 'EX', 86400)` for PAT revocation blocklist. MockRedis only had `setex(key, ttl, value)` which uses a different argument order. Admin integration tests were hanging because the real ioredis client was being invoked (after retries, it would throw).

## 2026-04-29 — Coverage Threshold Achievement (85%)

**Decision:** Added comprehensive integration and unit tests to reach 85.20% line coverage.

**New test files:**
- `tests/integration/routes/models.test.ts`
- `tests/integration/routes/quota.test.ts`
- `tests/integration/routes/admin.test.ts`
- `tests/integration/routes/responses.test.ts`
- `tests/unit/observability/metrics.test.ts`
- `tests/unit/utils/auth.test.ts`

**Expanded test files:**
- `tests/unit/utils/functional.test.ts` — added compose3, pipe3, curry3, throttle, partial
- `tests/integration/routes/health.test.ts` — added /metrics and Redis unhealthy tests
- `tests/unit/proxy/openai-chat.proxy.test.ts` — added `getDeploymentByAlias` mock

**Result:** Coverage improved from 76.43% to 85.20%.

## 2026-04-29 — Observability Completion (Phase 4)

**Decision:** Implemented full observability stack per PRD §4.4.

**Changes:**
- Custom `GatewaySampler` with 10% trace ID hash-based sampling
- `withSpan` wrapper in `createRequestHandler` — every request gets an OTEL span
- Span attributes updated to PRD names: `llm.tokens.input`, `llm.tokens.output`, `llm.tokens.thinking`
- `injectTraceContext` wired into `proxyNonStreamingChat` for `x-ms-client-request-id` propagation
- `logDebugBody()` added to logger for sanitized DEBUG-level body logging

## 2026-04-29 — Operational Hardening (Phase 5)

**Decision:** Made health checks configurable, fixed scheduler race, added OpenAPI spec and runbook.

**Changes:**
- `HEALTH_CHECK_ENABLED`, `HEALTH_CHECK_INTERVAL_MS`, `HEALTH_CHECK_TIMEOUT_MS` env vars
- Separate `cleanupRunning` / `archiveRunning` flags in scheduler (was shared `isRunning`)
- `openapi.json` served at `/openapi.json`
- Runbook with 6 incident scenarios in `.context/docs/runbook.md`
