# Observability

## Redis Error Handling Policy

The LLM Gateway implements a **fail-closed** policy for Redis-dependent operations. When Redis is unavailable or returns errors, the gateway rejects requests rather than bypassing security/quota protections.

### Policy Summary

| Component | Behavior on Redis Error | HTTP Response |
|-----------|----------------------|---------------|
| Rate Limiting | Fail closed | 429 Too Many Requests |
| PAT Auth Blocklist | Fail closed | 503 Service Unavailable |
| Quota Status | Fail closed | 429 Too Many Requests |
| Quota Reservation | Fail closed | 429 Too Many Requests |
| Quota Reconciliation | Fail closed | Error propagated to caller |

### Rationale

Infrastructure errors (Redis connection failures, timeouts) should **never** result in bypassing protections:

1. **Rate limiting** - Prevents API abuse even when Redis is down
2. **Auth blocklist** - Ensures revoked PATs remain blocked during Redis outages
3. **Quota management** - Prevents unbounded spending when quota cannot be enforced

### Implementation Details

#### Rate Limiting (`src/middleware/rate-limit.ts`)
- On Redis error: returns 429 with `rate_limit_exceeded` code
- No fallback to allow requests through

#### Auth Blocklist (`src/middleware/auth.ts`)
- On Redis error: returns 503 with `service_unavailable` code
- Uses dedicated `checkBlocklist()` function that catches Redis errors
- 503 indicates temporary issue, client should retry

#### Quota Status (`src/services/quota.service.ts`)
- Changed from `safeReadOrNull()` returning `null` (fail-open) to `getQuotaStatus()` returning `Result<QuotaStatus, QuotaError>` (fail-closed)
- Quota middleware (`src/middleware/quota.ts`) checks `isOk()` result and returns 429 if quota status cannot be determined
- Increment `quota_hydration_failures_total` metric

#### Quota Reconciliation (`src/services/quota.service.ts`)
- Changed from returning `Decimal(0)` on error to returning `ReconciliationResult` (fail-closed)
- Error includes `reservationId` for debugging
- Calling code propagates error and rejects the request

### Metrics

Prometheus metrics for monitoring Redis-related failures:

- `quota_hydration_failures_total` - Postgres sync failures
- `quota_exceeded_429_total` - Quota rejections (includes fail-closed Redis errors)
- `rate_limit_429_total` - Rate limit rejections
- `pat_revocations_total` - PAT revocation events

### Alerting Recommendations

Alert when `quota_hydration_failures_total` or `rate_limit_429_total` spikes, as this may indicate:
1. Redis connectivity issues
2. Redis latency exceeding thresholds
3. Actual quota exhaustion (legitimate growth)

### Health Checks

The `/healthz` endpoint includes Redis connectivity checks. If Redis is unhealthy:
- `/healthz` returns degraded status
- `/readyz` returns not ready, preventing traffic to gateway
