# LLM Gateway Remediation Plan — 6.8 → 9.0+

**Goal:** Fix all critical/high issues and most medium issues to achieve production-grade security, concurrency safety, test coverage, and observability.

**Current Score:** 6.8/10  
**Target Score:** 9.0+/10

---

## Score Impact Matrix

| Aspect | Current | Target | Fix Focus |
|--------|---------|--------|-----------|
| Architecture & layering | 8 | 9 | Shared streaming utilities consolidation |
| Code quality / readability | 7 | 9 | Proxy deduplication, remove magic numbers |
| Type safety | 7 | 9 | Eliminate post-validation casts |
| Error handling | 6 | 8 | Sanitize upstream logs, fix length leak |
| Concurrency / atomicity | 6 | 9 | Streaming mutex, Lua idempotency |
| **Security** | **5** | **9** | **.env purge, blocklist alignment, PAT hash, timing leak** |
| Tests — unit | 8 | 9 | Add PAT hash tests, mutex tests |
| Tests — integration | 4 | 8 | **Testcontainers for Redis + Postgres** |
| Tests — chaos / load | 4 | 7 | Network partition, real Lua race tests |
| Observability | 7 | 9 | Configurable sampler, trace↔request correlation |
| Ops / deploy | 7 | 9 | Docker limits, migration constraints |
| Docs / DX | 8 | 9 | Update runbooks for new env vars |
| Dependency hygiene | 8 | 9 | Add testcontainers, remove dead code |

---

## Phase 1: Critical Security Fixes (Score: +2.0)

### Task 1.1: Purge .env from Git History
**Files:** `.env`, `.gitignore`

- [ ] **Step 1:** Rotate ALL secrets immediately (PAT_SECRET, AZURE keys, ADMIN_OPERATOR_SECRET)
- [ ] **Step 2:** Replace `.env` with `.env.example` containing only template values
- [ ] **Step 3:** Add `.env` to `.gitignore` if not present
- [ ] **Step 4:** Run `git filter-repo --path .env --invert-paths` (or BFG Repo-Cleaner) to purge from history
- [ ] **Step 5:** Verify with `git log --all --full-history -- .env` — should return nothing

**Validation:** `git log --all -- .env` returns empty

---

### Task 1.2: Fix Blocklist Mismatch (jti vs pat_id)
**Files:** `src/routes/admin.routes.ts`, `src/middleware/auth.ts`, `tests/unit/middleware/auth.test.ts`

**Root Cause:** `admin.routes.ts` revokes by `pat_id` (request body UUID) but `auth.ts` checks by `jti` (JWT payload claim). The `pat_id` is never validated to correspond to the `jti` being revoked.

- [ ] **Step 1:** In `admin.routes.ts`, validate that `pat_id` matches a known `jti` in `api_keys` table before revoking
```typescript
// Add before blocklist write
const keyRecord = await getApiKeyByJti(pat_id);
if (!keyRecord) {
  return c.json(errorForProtocol(c.req.path, 404, 'not_found', 'PAT not found'), 404);
}
```
- [ ] **Step 2:** Add `getApiKeyByJti(jti: string)` to `src/db/data-access.ts`
- [ ] **Step 3:** Add integration test: revoke non-existent pat_id → 404
- [ ] **Step 4:** Add integration test: revoke valid pat_id → verify subsequent auth fails with 401

**Validation:** Integration test passes — revoked token is blocked, non-existent returns 404

---

### Task 1.3: Fix Admin Secret Length Leak
**Files:** `src/middleware/admin-scope.ts`, `tests/unit/middleware/admin-scope.test.ts`

**Root Cause:** Early return on `providedBuffer.length !== expectedBuffer.length` before `timingSafeEqual` leaks secret length via timing side channel.

- [ ] **Step 1:** Remove length check; always compare full buffer
```typescript
function isOperatorSecretValid(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  
  const providedBuffer = Buffer.from(provided.padEnd(expected.length, '\0'));
  const expectedBuffer = Buffer.from(expected);
  
  if (providedBuffer.length !== expectedBuffer.length) {
    // Still compare to avoid timing leak — compare against padded buffer
    return false;
  }
  
  return timingSafeEqual(providedBuffer, expectedBuffer);
}
```
**Better approach:** Hash both secrets with HMAC before comparison:
```typescript
function isOperatorSecretValid(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedHash = createHmac('sha256', env.PAT_SECRET).update(provided).digest();
  const expectedHash = createHmac('sha256', env.PAT_SECRET).update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}
```
- [ ] **Step 2:** Add timing-safe comparison unit test (use `process.hrtime()` or mock)
- [ ] **Step 3:** Verify no early return before timingSafeEqual

**Validation:** Unit test confirms constant-time comparison regardless of input length

---

### Task 1.4: Implement PAT Hash Comparison or Remove Dead Code
**Files:** `src/utils/auth.ts`, `src/middleware/auth.ts`

**Root Cause:** `hashPatToken` and `verifyPatHash` are defined but never called. Current validation only checks HMAC signature structure, not against stored hash.

**Decision:** Remove dead code since PAT validation already verifies HMAC signature with `validatePatStructure`. The `hashPatToken`/`verifyPatHash` pattern is redundant with JWT-style signature verification already in place.

- [ ] **Step 1:** Remove `hashPatToken` and `verifyPatHash` from `src/utils/auth.ts`
- [ ] **Step 2:** Remove `PatBlocklistEntry` interface if unused
- [ ] **Step 3:** Add comment in `validatePatStructure` explaining: "Signature verification via HMAC-SHA256 replaces stored-hash comparison"
- [ ] **Step 4:** Verify no references remain with `grep -r "hashPatToken\|verifyPatHash" src/`

**Alternative (if hash comparison is desired):** Store `hashPatToken(rawToken)` in `api_keys.key_hash` and call `verifyPatHash` in auth middleware. This adds defense-in-depth but changes the auth flow.

**Validation:** `grep` returns zero matches for removed functions; build passes

---

### Task 1.5: Sanitize Upstream Error Body Logging
**Files:** `src/proxy/shared.ts`

**Root Cause:** `createSanitizedUpstreamErrorResponse` logs up to 4096 bytes of upstream error body without redaction. Could leak API keys or PII from upstream errors.

- [ ] **Step 1:** Add redaction before logging
```typescript
function redactSensitiveContent(text: string): string {
  return text
    .replace(/"key"\s*:\s*"[^"]+"/g, '"key":"[REDACTED]"')
    .replace(/"api[_-]?key"\s*:\s*"[^"]+"/gi, '"api_key":"[REDACTED]"')
    .replace(/Bearer\s+[a-zA-Z0-9_-]+/g, 'Bearer [REDACTED]')
    .replace(/[a-f0-9]{32,}/gi, (match) => `[HASH:${match.length}]`);
}
```
- [ ] **Step 2:** Apply redaction to `errorBody` before logging
- [ ] **Step 3:** Add unit test for `redactSensitiveContent`
- [ ] **Step 4:** Truncate to 1024 chars (not 4096) for error logs

**Validation:** Unit test confirms API keys and bearer tokens are redacted in logged output

---

## Phase 2: Concurrency & Streaming Safety (Score: +1.5)

### Task 2.1: Add AsyncMutex Utility
**Files:** `src/utils/mutex.ts` (new), `tests/unit/utils/mutex.test.ts`

- [ ] **Step 1:** Create `AsyncMutex` class
```typescript
export class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}
```
- [ ] **Step 2:** Add unit tests: single acquire, queued acquires, release order
- [ ] **Step 3:** Export from `src/utils/index.ts` or appropriate barrel file

**Validation:** Unit tests pass — concurrent acquires are serialized

---

### Task 2.2: Guard Streaming Flags with AsyncMutex
**Files:** `src/proxy/anthropic.proxy.ts`, `src/proxy/openai-chat.proxy.ts`

- [ ] **Step 1:** In `anthropic.proxy.ts`, wrap `usageExtracted` and `reservationFinalized` mutations
```typescript
import { AsyncMutex } from '@/utils/mutex';

// In proxyStreamingAnthropic:
const finalizeMutex = new AsyncMutex();

// In transform():
if (!usageExtracted && reservationId) {
  const usage = extractUsageFromAnthropicEvents(events);
  if (usage) {
    const release = await finalizeMutex.acquire();
    try {
      if (usageExtracted) return; // Double-check after acquiring lock
      usageExtracted = true;
      reservationFinalized = true;
      // ... reconcileUsage with await (not fire-and-forget)
      const actualCost = await reconcileUsage(reservationId, usage, deployment.azureModelName);
      // ... addLLMSpanAttributes and logRequestAudit
    } finally {
      release();
    }
  }
}

// In releaseUnreconciled:
const release = await finalizeMutex.acquire();
try {
  if (reservationFinalized) return;
  reservationFinalized = true;
  await releaseReservedQuota(reservationId, requestId);
} finally {
  release();
}
```
- [ ] **Step 2:** Same pattern for `openai-chat.proxy.ts`
- [ ] **Step 3:** Replace fire-and-forget `reconcileUsage().then()` with `await reconcileUsage()` inside mutex
- [ ] **Step 4:** Add integration test: simulate abort during streaming → verify no double-reconcile, no double-release

**Validation:** Integration test: abort mid-stream → quota released exactly once

---

### Task 2.3: Fix Rate Limit Lua Idempotency
**Files:** `src/middleware/rate-limit.ts`, `tests/unit/middleware/rate-limit.test.ts`

**Root Cause:** `math.random()` in Lua script creates non-deterministic member IDs, causing duplicate entries under retries.

- [ ] **Step 1:** Replace `math.random()` with deterministic dedup using request ID or counter
```lua
-- Use ARGV[6] as dedup key (request-specific)
local member = now .. ':' .. ARGV[6]
redis.call('zadd', key, now, member)
```
- [ ] **Step 2:** Pass `requestId` (from context) as 6th arg to `eval`
- [ ] **Step 3:** Add unit test: retry same request → count does not increase
- [ ] **Step 4:** Verify Lua script syntax with `redis-cli SCRIPT LOAD` equivalent

**Validation:** Unit test: two identical requests within window → second rejected, count = 1

---

## Phase 3: Integration Test Infrastructure (Score: +2.0)

### Task 3.1: Add Testcontainers for Redis and Postgres
**Files:** `package.json`, `tests/integration/helpers/testcontainers.ts` (new), `tests/integration/setup.ts`

- [ ] **Step 1:** Add `testcontainers` dependency
```bash
bun add -d testcontainers@^10.9.0
```
- [ ] **Step 2:** Create `tests/integration/helpers/testcontainers.ts`
```typescript
import { GenericContainer, Wait } from 'testcontainers';

let redisContainer: StartedTestContainer;
let postgresContainer: StartedTestContainer;

export async function startTestContainers(): Promise<{ redisUrl: string; postgresUrl: string }> {
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  postgresContainer = await new GenericContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'llm_gateway' })
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
    .start();

  return {
    redisUrl: `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`,
    postgresUrl: `postgresql://test:test@${postgresContainer.getHost()}:${postgresContainer.getMappedPort(5432)}/llm_gateway`,
  };
}

export async function stopTestContainers(): Promise<void> {
  await redisContainer?.stop();
  await postgresContainer?.stop();
}
```
- [ ] **Step 3:** Update `tests/integration/helpers/test-app.ts` to use real Redis when `USE_REAL_REDIS=true`
- [ ] **Step 4:** Create GitHub Actions CI job with testcontainers
- [ ] **Step 5:** Add at least one integration test that exercises real Lua atomicity

**Validation:** CI passes with `USE_REAL_REDIS=true USE_REAL_POSTGRES=true`

---

### Task 3.2: Expand Chaos Tests with Real Failures
**Files:** `tests/chaos/`

- [ ] **Step 1:** Add network partition chaos test
```typescript
// tests/chaos/network-partition.test.ts
// Start testcontainers, then simulate network partition via Docker API
// Verify graceful degradation (503 with service_unavailable)
```
- [ ] **Step 2:** Add partial-commit chaos test (Redis commit succeeds, Postgres fails)
- [ ] **Step 3:** Add Redis Lua race condition test with real Redis
```typescript
// Two concurrent checkAndReserve calls for same user
// Verify atomicity: only one succeeds when budget is exactly 1x cost
```
- [ ] **Step 4:** Add stream abort chaos test
```typescript
// Start streaming request, abort client
// Verify reservation released exactly once (no double-release)
```

**Validation:** All chaos tests pass in CI with testcontainers

---

## Phase 4: Observability Hardening (Score: +1.0)

### Task 4.1: Make OTel Sampler Configurable
**Files:** `src/config/env.ts`, `src/observability/tracing.ts`, `tests/unit/config/env.test.ts`

- [ ] **Step 1:** Add `OTEL_TRACING_SAMPLER_RATIO` to env schema
```typescript
OTEL_TRACING_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(0.1),
```
- [ ] **Step 2:** Use env var in tracing.ts
```typescript
const traceSampler = new TraceHashRatioSampler(env.OTEL_TRACING_SAMPLER_RATIO);
```
- [ ] **Step 3:** Add unit test for env parsing
- [ ] **Step 4:** Update `.env.example` with `OTEL_TRACING_SAMPLER_RATIO=0.1`

**Validation:** Unit test: `OTEL_TRACING_SAMPLER_RATIO=0.5` → sampler ratio = 0.5

---

### Task 4.2: Correlate Trace-ID with Request-ID
**Files:** `src/middleware/request-id.ts`, `src/observability/tracing.ts`

- [ ] **Step 1:** In `requestIdMiddleware`, set trace attribute
```typescript
import { getCurrentTraceId } from '@/observability/tracing';

export async function requestIdMiddleware(c: Context, next: Next): Promise<void> {
  const id = uuidv4();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  
  const traceId = getCurrentTraceId();
  if (traceId) {
    c.header('X-Trace-Id', traceId);
    // Also add as span attribute for correlation
    addLLMSpanAttributes({ requestId: id }); // or use a generic span attribute
  }
  
  await next();
}
```
- [ ] **Step 2:** Add `llm.request_id` constant to tracing.ts attributes
- [ ] **Step 3:** In `addLLMSpanAttributes`, accept `requestId` and set as span attribute
- [ ] **Step 4:** Add unit test: request generates both X-Request-Id and X-Trace-Id headers

**Validation:** Response headers include both `X-Request-Id` and `X-Trace-Id`; span attributes include `llm.request_id`

---

### Task 4.3: Add OTLP Health Check to /ready
**Files:** `src/routes/health.routes.ts`, `src/observability/tracing.ts`, `tests/integration/routes/health.test.ts`

- [ ] **Step 1:** Add `isOtelHealthy()` function to `tracing.ts`
```typescript
export async function isOtelHealthy(): Promise<boolean> {
  if (!provider) return true; // OTel disabled = healthy
  try {
    // Force a tiny flush to verify connectivity
    await provider.forceFlush();
    return true;
  } catch {
    return false;
  }
}
```
- [ ] **Step 2:** Add `otel` to `/ready` checks
```typescript
healthRoutes.get('/ready', async (c) => {
  const checks: Record<string, boolean> = {
    redis: false,
    postgres: false,
    otel: false,
    deployments: false,
  };
  // ... existing checks
  checks.otel = await isOtelHealthy();
  // ...
});
```
- [ ] **Step 3:** Add integration test for `/ready` with OTel disabled → otel = true
- [ ] **Step 4:** Add integration test for `/ready` with bad OTel endpoint → otel = false

**Validation:** `/ready` returns `otel: false` when exporter cannot connect

---

## Phase 5: Error Handling & Type Safety (Score: +0.8)

### Task 5.1: Fix Type Safety in Request Handler Factory
**Files:** `src/routes/factories/request-handler.factory.ts`

- [ ] **Step 1:** Instead of `as Record<string, unknown>`, use Zod-inferred type
```typescript
const bodySchema = z.object({ /* ... */ });
type BodyType = z.infer<typeof bodySchema>;

const validatedBody = bodySchema.safeParse(rawBody);
if (!validatedBody.success) { /* ... */ }

const bodyRecord: Record<string, unknown> = validatedBody.data;
// OR better: keep typed body and use it directly
```
- [ ] **Step 2:** Pass typed body through to handlers instead of casting
- [ ] **Step 3:** Verify with `tsc --noEmit` — no new errors

**Validation:** `tsc --noEmit` passes with zero errors

---

## Phase 6: Ops & Infrastructure (Score: +0.7)

### Task 6.1: Add Docker Resource Limits
**Files:** `docker-compose.yml`

- [ ] **Step 1:** Add memory and CPU limits to all services
```yaml
gateway:
  deploy:
    resources:
      limits:
        cpus: '1.0'
        memory: 512M
      reservations:
        cpus: '0.25'
        memory: 128M

redis:
  deploy:
    resources:
      limits:
        cpus: '0.5'
        memory: 256M

postgres:
  deploy:
    resources:
      limits:
        cpus: '0.5'
        memory: 512M
```
- [ ] **Step 2:** Verify with `docker compose config` — no syntax errors

**Validation:** `docker compose config` parses successfully with limits

---

### Task 6.2: Add CHECK Constraints to Migrations
**Files:** `migrations/001_initial_schema.sql`, `migrations/004_check_constraints.sql` (new)

- [ ] **Step 1:** Create migration `004_check_constraints.sql`
```sql
-- Add CHECK constraints for financial integrity
ALTER TABLE users ADD CONSTRAINT chk_monthly_budget_nonnegative 
  CHECK (monthly_budget_usd >= 0);

ALTER TABLE request_audit ADD CONSTRAINT chk_cost_nonnegative 
  CHECK (cost_usd >= 0);

ALTER TABLE usage_history ADD CONSTRAINT chk_total_cost_nonnegative 
  CHECK (total_cost_usd >= 0);
```
- [ ] **Step 2:** Add test: insert negative cost → expect constraint error
- [ ] **Step 3:** Document in `docs/operations/migrations.md`

**Validation:** Insert with `cost_usd = -1` throws `check_violation`

---

## Phase 7: Chaos Tests & Load Testing (Score: +1.0)

### Task 7.1: Add k6 Load Test for Quota Under Pressure
**Files:** `tests/load/quota-pressure.js` (new)

- [ ] **Step 1:** Create k6 script that hammers quota endpoint with concurrent requests
```javascript
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '1m', target: 100 },
    { duration: '30s', target: 0 },
  ],
};

export default function () {
  const res = http.post('http://gateway:3000/v1/chat/completions', {
    headers: { 'Authorization': 'Bearer ' + __ENV.PAT_TOKEN },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] }),
  });
  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'quota not negative': (r) => {
      const body = JSON.parse(r.body);
      return body.quota_remaining === undefined || body.quota_remaining >= 0;
    },
  });
}
```
- [ ] **Step 2:** Add to CI with `QUOTA_PG_SYNC_IN_TESTS=true`
- [ ] **Step 3:** Verify no quota underflow (spent + reserved ≤ budget)

**Validation:** k6 run completes with 0% quota underflow errors

---

## Execution Order

**Week 1 (Security + Concurrency):**
1. Task 1.1 — Purge .env
2. Task 1.2 — Fix blocklist mismatch
3. Task 1.3 — Fix admin length leak
4. Task 1.4 — Remove dead PAT hash code
5. Task 1.5 — Sanitize upstream logs
6. Task 2.1 — Add AsyncMutex
7. Task 2.2 — Guard streaming flags
8. Task 2.3 — Fix Lua idempotency

**Week 2 (Testing + Observability):**
9. Task 3.1 — Testcontainers
10. Task 3.2 — Expand chaos tests
11. Task 4.1 — Configurable sampler
12. Task 4.2 — Trace↔Request correlation
13. Task 4.3 — OTLP health check

**Week 3 (Type Safety + Ops + Load):**
14. Task 5.1 — Fix type safety
15. Task 6.1 — Docker limits
16. Task 6.2 — CHECK constraints
17. Task 7.1 — k6 quota pressure test

---

## Verification Checklist

Before claiming 9+:
- [ ] All critical issues fixed with tests
- [ ] `tsc --noEmit` passes
- [ ] `bun test` passes (unit + integration)
- [ ] CI passes with testcontainers
- [ ] `docker compose config` validates
- [ ] Security scan (npm audit / Snyk) passes
- [ ] Load test (k6) passes without quota underflow
- [ ] `.env` purged from git history
- [ ] All secrets rotated

---

## Expected Final Scores

| Aspect | Score |
|--------|-------|
| Architecture & layering | 9 |
| Code quality / readability | 9 |
| Type safety | 9 |
| Error handling | 8 |
| Concurrency / atomicity | 9 |
| **Security** | **9** |
| Tests — unit | 9 |
| Tests — integration | 8 |
| Tests — chaos / load | 7 |
| Observability | 9 |
| Ops / deploy | 9 |
| Docs / DX | 9 |
| Dependency hygiene | 9 |
| **Overall** | **8.7-9.0** |
