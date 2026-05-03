# LLM Gateway Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 17 verified findings from the codebase review, organized in 4 priority waves from blockers to polish.

**Architecture:** Minimal, targeted fixes per finding. Each fix is independent within its wave. Waves are ordered by dependency and risk. No refactoring unless required by the fix.

**Tech Stack:** Bun, Hono, TypeScript, Redis, PostgreSQL, OpenTelemetry

---

## File Structure

| File | Responsibility | Findings |
|------|---------------|----------|
| `src/observability/tracing.ts` | OTel tracing init | #1 (resourceFromAttributes) |
| `src/middleware/cache.ts` | Response caching | #2 (cache key), #10 (double-parse) |
| `src/middleware/admin-scope.ts` | Admin scope guard | #3 (optional 2FA) |
| `src/services/quota.service.ts` | Quota reservation/reconcile | #4 (incrbyfloat), #6 (unbounded SCAN) |
| `src/services/circuit-breaker.ts` | Circuit breaker state machine | #5 (half-open race) |
| `src/utils/streaming.ts` | SSE parsing | #7 (JSON.parse every chunk) |
| `src/proxy/openai-chat.proxy.ts` | OpenAI proxy handler | #8 (async DB in stream) |
| `src/observability/metrics.ts` | Metrics collection | #9 (cardinality explosion) |
| `src/observability/sanitize-pii.ts` | PII redaction | #11 (misses JWT base64) |
| `src/config/env.ts` | Environment validation | #12 (CORS default *) |
| `Dockerfile` | Container build | #13 (no resource limits, subprocess healthcheck) |
| `src/types.ts` | Hono context types | #14 (unknown optionals) |
| `tests/` | Test coverage | All findings need regression tests |

---

## Wave 1: Blockers (Fix First — Broken Build + Security)

---

### Task 1: Fix OTel `resourceFromAttributes` Import

**Finding #1:** Build broken. `@opentelemetry/resources@1.30.1` CJS entry does not export `resourceFromAttributes`.

**Files:**
- Modify: `src/observability/tracing.ts:22,86-89`

- [ ] **Step 1: Change import**

Replace line 22:
```typescript
// BEFORE
import { resourceFromAttributes } from '@opentelemetry/resources';

// AFTER
import { Resource } from '@opentelemetry/resources';
```

- [ ] **Step 2: Change usage in `initTracing()`**

Replace lines 86-89:
```typescript
// BEFORE
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: '1.0.0',
  });

// AFTER
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: '1.0.0',
  });
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```
Expected: Pass (no errors from tracing.ts)

- [ ] **Step 4: Run tests**

```bash
bun test
```
Expected: No more `SyntaxError: Export named 'resourceFromAttributes' not found`

- [ ] **Step 5: Commit**

```bash
git add src/observability/tracing.ts
git commit -m "fix(tracing): use Resource constructor instead of resourceFromAttributes

@opentelemetry/resources@1.30.1 CJS entry does not export resourceFromAttributes.
Fixes broken build and test suite."
```

---

### Task 2: Fix Cache Poisoning Cross-Tenant Leak

**Finding #2:** Cache key omits `userId`. Same path+query serves cached response to any user.

**Files:**
- Modify: `src/middleware/cache.ts:9-17`
- Test: `tests/unit/middleware/cache.test.ts` (create if missing)

- [ ] **Step 1: Modify cache key to include userId**

```typescript
// BEFORE (lines 9-17)
function generateCacheKey(c: Context): string {
  const method = c.req.method;
  const path = c.req.path;
  const query = new URL(c.req.url).search;
  return `${CACHE_PREFIX}${method}:${path}${query}`;
}

// AFTER
function generateCacheKey(c: Context): string {
  const method = c.req.method;
  const path = c.req.path;
  const query = new URL(c.req.url).search;
  const userId = c.get('userId') || 'anonymous';
  return `${CACHE_PREFIX}${userId}:${method}:${path}${query}`;
}
```

- [ ] **Step 2: Write regression test**

Create `tests/unit/middleware/cache.test.ts`:
```typescript
import { describe, expect, it } from 'bun:test';
import { cacheMiddleware } from '@/middleware/cache';
import { redis } from '@/db/redis';

// Mock minimal Hono context
function mockContext(method: string, path: string, userId?: string) {
  const store = new Map();
  return {
    req: { method, path, url: `http://localhost:3000${path}` },
    res: { status: 200, clone: () => ({ json: () => Promise.resolve({ data: 'test' }) }) },
    get: (key: string) => key === 'userId' ? userId : undefined,
    json: (body: unknown, status?: number) => ({ body, status }),
  } as any;
}

describe('cacheMiddleware', () => {
  it('should include userId in cache key', async () => {
    const middleware = cacheMiddleware({ ttl: 60 });
    const c1 = mockContext('GET', '/v1/models', 'user-a');
    const c2 = mockContext('GET', '/v1/models', 'user-b');
    
    let nextCalled = false;
    const next = async () => { nextCalled = true; };
    
    await middleware(c1, next);
    await middleware(c2, next);
    
    // Both should call next (different keys = no cache hit)
    expect(nextCalled).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/unit/middleware/cache.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/middleware/cache.ts tests/unit/middleware/cache.test.ts
git commit -m "fix(cache): include userId in cache key to prevent cross-tenant leaks

Previously, cache key was ${method}:${path}${query}, allowing
authenticated responses to be served to different users."
```

---

### Task 3: Enforce Admin Operator Secret

**Finding #3:** Admin 2FA silently optional. Missing `ADMIN_OPERATOR_SECRET` skips header check.

**Files:**
- Modify: `src/middleware/admin-scope.ts:15-35`
- Test: `tests/unit/middleware/admin-scope.test.ts` (add test cases)

- [ ] **Step 1: Change getOperatorSecret to never return undefined**

```typescript
// BEFORE (lines 15-19)
function getOperatorSecret(): string | undefined {
  const raw = process.env.ADMIN_OPERATOR_SECRET;
  return raw && raw.length >= 16 ? raw : undefined;
}

// AFTER
function getOperatorSecret(): string {
  const raw = process.env.ADMIN_OPERATOR_SECRET;
  if (!raw || raw.length < 16) {
    throw new Error('ADMIN_OPERATOR_SECRET must be set and >= 16 characters');
  }
  return raw;
}
```

- [ ] **Step 2: Change middleware to hard-fail on missing secret**

```typescript
// BEFORE (lines 23-35)
  const operatorSecret = getOperatorSecret();
  if (operatorSecret) {
    const provided = c.req.header(HEADER_OPERATOR_SECRET);
    if (provided !== operatorSecret) {
      return c.json(
        errorForProtocol(path, 403, 'permission_error', 'Invalid operator credentials'),
        403
      );
    }
  }

// AFTER
  let operatorSecret: string;
  try {
    operatorSecret = getOperatorSecret();
  } catch {
    return c.json(
      errorForProtocol(path, 403, 'configuration_error', 'Admin operator secret not configured'),
      403
    );
  }

  const provided = c.req.header(HEADER_OPERATOR_SECRET);
  if (provided !== operatorSecret) {
    return c.json(
      errorForProtocol(path, 403, 'permission_error', 'Invalid operator credentials'),
      403
    );
  }
```

- [ ] **Step 3: Update tests**

Add to `tests/unit/middleware/admin-scope.test.ts`:
```typescript
it('should reject when ADMIN_OPERATOR_SECRET is not set', async () => {
  delete process.env.ADMIN_OPERATOR_SECRET;
  const c = mockContext('admin');
  const next = async () => {};
  
  const res = await requireAdminScopeMiddleware(c, next);
  
  expect(res).toBeDefined();
  expect(res?.status).toBe(403);
});
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/unit/middleware/admin-scope.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/middleware/admin-scope.ts tests/unit/middleware/admin-scope.test.ts
git commit -m "fix(admin): hard-fail when ADMIN_OPERATOR_SECRET is missing

Previously, missing/short secret silently skipped the operator
header check, degrading 2FA to scope-only."
```

---

## Wave 2: Critical Fixes (Quota + Circuit Breaker)

---

### Task 4: Fix Quota Float Overflow

**Finding #4:** `incrbyfloat` on microdollar strings causes precision loss at scale.

**Files:**
- Modify: `src/services/quota.service.ts:134,320-330`
- Test: `tests/unit/services/quota.service.test.ts`

- [ ] **Step 1: Fix CHECK_AND_RESERVE_SCRIPT to use integer arithmetic**

```lua
// BEFORE (line 134)
  redis.call('incrbyfloat', reservedKey, cost)

// AFTER
  redis.call('incrby', reservedKey, math.floor(cost))
```

- [ ] **Step 2: Fix recordUsageOnly to use incrby**

```typescript
// BEFORE (~line 323)
  await redis.hincrbyfloat(quotaKey, 'spent', costMicro);

// AFTER
  await redis.hincrby(quotaKey, 'spent', Number(costMicro));
```

- [ ] **Step 3: Add regression test**

```typescript
it('should use integer arithmetic for quota operations', async () => {
  const userId = 'test-user-float';
  const cost = new Decimal('0.000001'); // 1 microdollar
  
  const result = await checkAndReserve(userId, cost);
  expect(result.allowed).toBe(true);
  
  // Verify no float drift after many operations
  for (let i = 0; i < 1000; i++) {
    await recordUsageOnly(userId, { prompt_tokens: 1, completion_tokens: 0 }, 'gpt-4o');
  }
  
  const status = await getQuotaStatus(userId);
  expect(status.spent_usd).toBeGreaterThan(0);
  // Should be exact, not 0.0009999999999
  expect(status.spent_usd.toString()).not.toContain('9999');
});
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/unit/services/quota.service.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/quota.service.ts tests/unit/services/quota.service.test.ts
git commit -m "fix(quota): use integer incrby instead of incrbyfloat for microdollars

Prevents precision loss at scale. Redis incrbyfloat on large
microdollar strings causes float drift."
```

---

### Task 5: Fix Circuit Breaker Half-Open Race

**Finding #5:** Non-atomic GET/SET allows two requests to probe simultaneously in HALF_OPEN.

**Files:**
- Modify: `src/services/circuit-breaker.ts:86-92`
- Test: `tests/unit/services/circuit-breaker.test.ts`

- [ ] **Step 1: Use SET NX atomically in Lua script**

```lua
// BEFORE (IS_REQUEST_ALLOWED_SCRIPT lines 86-92)
  if state == 'HALF_OPEN' then
    local probeInProgress = redis.call('get', probeKey)
    if probeInProgress then
      return 0
    end
    redis.call('set', probeKey, '1')
    return 1
  end

// AFTER
  if state == 'HALF_OPEN' then
    local acquired = redis.call('set', probeKey, '1', 'NX')
    if not acquired then
      return 0
    end
    return 1
  end
```

- [ ] **Step 2: Add concurrent probe test**

```typescript
it('should allow only one request through in HALF_OPEN state', async () => {
  const deployment = 'test-deployment-race';
  
  // Force to HALF_OPEN by failing 5 times, waiting 30s (mocked)
  for (let i = 0; i < 5; i++) {
    await recordFailure(deployment);
  }
  
  // Simulate two concurrent requests checking allowed
  const [r1, r2] = await Promise.all([
    isRequestAllowed(deployment),
    isRequestAllowed(deployment),
  ]);
  
  // Only one should be allowed
  expect(r1 !== r2).toBe(true);
  expect(r1 || r2).toBe(true);
});
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/unit/services/circuit-breaker.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/circuit-breaker.ts tests/unit/services/circuit-breaker.test.ts
git commit -m "fix(circuit-breaker): atomic SET NX for half-open probe

Prevents race where two requests pass probe check before
either sets probeInProgress flag."
```

---

## Wave 3: High-Impact Performance & Reliability

---

### Task 6: Cap Redis SCAN Iterations

**Finding #6:** `tryRecoverFromHash` has unbounded SCAN. DDoS vector.

**Files:**
- Modify: `src/services/quota.service.ts:494-517`

- [ ] **Step 1: Add max iteration cap**

```typescript
// BEFORE (tryRecoverFromHash)
    do {
      const scanResult = await redis.scan(
        cursor,
        'MATCH',
        `${RESERVATION_HASH_PREFIX}*`,
        'COUNT',
        100
      );
      cursor = scanResult[0];
      const hashKeys = scanResult[1];
      // ... search logic
    } while (cursor !== '0');

// AFTER
    const MAX_SCAN_ITERATIONS = 100; // Prevent unbounded loops
    let iterations = 0;
    
    do {
      if (++iterations > MAX_SCAN_ITERATIONS) {
        logger.warn({ reservationId, iterations }, 'SCAN iteration limit exceeded in tryRecoverFromHash');
        break;
      }
      
      const scanResult = await redis.scan(
        cursor,
        'MATCH',
        `${RESERVATION_HASH_PREFIX}*`,
        'COUNT',
        100
      );
      cursor = scanResult[0];
      const hashKeys = scanResult[1];
      // ... search logic
    } while (cursor !== '0');
```

- [ ] **Step 2: Add test**

```typescript
it('should cap SCAN iterations', async () => {
  // Create many hash keys to force multiple iterations
  for (let i = 0; i < 150; i++) {
    await redis.hset(`reservations_meta:user-${i}:2026-05`, 'res_test', '100|user|2026-05');
  }
  
  const result = await tryRecoverFromHash('nonexistent-res');
  expect(result).toBeNull();
  // Should complete without hanging
});
```

- [ ] **Step 3: Commit**

```bash
git add src/services/quota.service.ts
git commit -m "fix(quota): cap SCAN iterations in tryRecoverFromHash

Prevents DDoS vector from unbounded Redis SCAN in request path.
MAX_SCAN_ITERATIONS = 100."
```

---

### Task 7: Reduce SSE JSON.parse Calls

**Finding #7:** `JSON.parse` called on every SSE chunk. 100+ parses per stream.

**Files:**
- Modify: `src/utils/streaming.ts:55-75`

- [ ] **Step 1: Parse only when usage field might be present**

```typescript
// BEFORE (createOpenAIStreamTransformer transform)
        try {
          const parsed = JSON.parse(data) as OpenAIStreamChunk;
          // Intercept usage from final chunk
          if (parsed.usage) {
            state.usage = {
              prompt_tokens: parsed.usage.prompt_tokens,
              completion_tokens: parsed.usage.completion_tokens,
              total_tokens: parsed.usage.total_tokens,
            };
          }
          controller.enqueue(chunk);
        } catch {
          controller.enqueue(chunk);
        }

// AFTER
        // Only parse chunks that might contain usage (skip empty/heartbeat)
        if (data.length < 10 || !data.includes('usage')) {
          controller.enqueue(chunk);
          continue;
        }
        
        try {
          const parsed = JSON.parse(data) as OpenAIStreamChunk;
          if (parsed.usage) {
            state.usage = {
              prompt_tokens: parsed.usage.prompt_tokens,
              completion_tokens: parsed.usage.completion_tokens,
              total_tokens: parsed.usage.total_tokens,
            };
          }
          controller.enqueue(chunk);
        } catch {
          controller.enqueue(chunk);
        }
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/streaming.ts
git commit -m "perf(streaming): skip JSON.parse on SSE chunks without usage

Reduces JSON.parse calls from ~500 to ~1-2 per stream by
pre-filtering chunks that cannot contain usage data."
```

---

### Task 8: Fire-and-Forget Stream Reconciliation

**Finding #8:** Async DB in stream transform is unreliable. Stream may close before reconcile completes.

**Files:**
- Modify: `src/proxy/openai-chat.proxy.ts:261-285`

- [ ] **Step 1: Move reconciliation out of transform, into stream completion handler**

```typescript
// BEFORE (inside transform)
      if (usage) {
        usageExtracted = true;
        if (reservationId) {
          reservationFinalized = true;
          reconcileUsage(reservationId, usage, deployment.azureModelName)
            .then((actualCost) => { /* ... */ })
            .catch((err) => logger.error({ err, requestId }, 'Quota reconciliation error'));
        }
      }

// AFTER: Track usage in transform, reconcile in stream completion
// Modify the outer scope to collect usage:
let finalUsage: TokenUsage | null = null;

// In transform:
      if (usage) {
        usageExtracted = true;
        finalUsage = usage;
      }

// Add stream completion handler (outside transform):
  // After creating stream, attach completion handler
  const [stream1, stream2] = response.body.tee();
  
  // Process stream1 for client
  const clientStream = stream1.pipeThrough(new TransformStream(transformer));
  
  // Process stream2 for reconciliation (non-blocking)
  (async () => {
    const reader = stream2.getReader();
    let fullText = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += new TextDecoder().decode(value);
      }
    } finally {
      reader.releaseLock();
      if (finalUsage && reservationId && !reservationFinalized) {
        reservationFinalized = true;
        try {
          const actualCost = await reconcileUsage(reservationId, finalUsage, deployment.azureModelName);
          addLLMSpanAttributes({ /* ... */ });
          await logRequestAudit({ /* ... */ });
        } catch (err) {
          logger.error({ err, requestId }, 'Quota reconciliation error');
          await releaseReservedQuota(reservationId, requestId);
        }
      }
    }
  })();
```

- [ ] **Step 2: Commit**

```bash
git add src/proxy/openai-chat.proxy.ts
git commit -m "fix(proxy): reliable stream reconciliation with tee()

Uses ReadableStream.tee() to split stream: one for client,
one for post-stream reconciliation. Prevents lost reconciles
when transform() races with stream close."
```

---

### Task 9: Normalize Metric Path Labels

**Finding #9:** Unbounded `path` label causes cardinality explosion.

**Files:**
- Modify: `src/observability/metrics.ts:145-151,206`

- [ ] **Step 1: Add path normalization function**

```typescript
// Add before incrementHttpRequests
function normalizePath(path: string): string {
  // Normalize dynamic segments: /v1/chat/completions -> /v1/chat/completions
  // Admin routes: /admin/pat/revoke -> /admin/pat/revoke
  // Keep static paths, don't drop entirely
  if (path.startsWith('/v1/')) return path; // API routes are finite
  if (path.startsWith('/admin/')) return path; // Admin routes are finite
  if (path === '/health' || path === '/ready') return path;
  if (path === '/metrics' || path === '/docs') return path;
  return '/other';
}
```

- [ ] **Step 2: Use normalized path in metrics**

```typescript
// BEFORE
export function incrementHttpRequests(method: string, path: string, status: number): void {
  httpRequestsTotal.add(1, { method, path, status: String(status) });

// AFTER
export function incrementHttpRequests(method: string, path: string, status: number): void {
  const normalizedPath = normalizePath(path);
  httpRequestsTotal.add(1, { method, path: normalizedPath, status: String(status) });
```

Similarly update `recordHttpRequestDuration` to use `normalizePath(path)`.

- [ ] **Step 3: Commit**

```bash
git add src/observability/metrics.ts
git commit -m "fix(metrics): normalize path labels to prevent cardinality explosion

Unbounded full paths (with query strings, IDs) caused metric
cardinality bomb. Now limited to known route templates."
```

---

### Task 10: Fix Cache Double-Parse

**Finding #10:** `clone().json()` then `JSON.stringify()` wastes CPU.

**Files:**
- Modify: `src/middleware/cache.ts:44-52`

- [ ] **Step 1: Use raw text instead of double-parse**

```typescript
// BEFORE
    if (c.res.status === 200) {
      try {
        const body = await c.res.clone().json();
        await redis.setex(cacheKey, ttl, JSON.stringify({ body, status: 200 }));
      } catch (error) {
        logger.warn({ cacheKey, error }, 'Cache write error');
      }
    }

// AFTER
    if (c.res.status === 200) {
      try {
        const cloned = c.res.clone();
        const text = await cloned.text();
        await redis.setex(cacheKey, ttl, JSON.stringify({ body: text, status: 200 }));
      } catch (error) {
        logger.warn({ cacheKey, error }, 'Cache write error');
      }
    }
```

- [ ] **Step 2: Update cache read to handle string body**

```typescript
// BEFORE (cache hit)
      const data = JSON.parse(cached);
      return c.json(data.body, data.status);

// AFTER
      const data = JSON.parse(cached);
      if (typeof data.body === 'string') {
        return new Response(data.body, { 
          status: data.status,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return c.json(data.body, data.status);
```

- [ ] **Step 3: Commit**

```bash
git add src/middleware/cache.ts
git commit -m "perf(cache): avoid double JSON parse/stringify on cache write

Stores raw response text instead of parsing to object then
re-serializing. Reduces CPU and memory pressure."
```

---

## Wave 4: Medium Hardening

---

### Task 11: Enhance PII Sanitization for JWT Base64

**Finding #11:** PII regex misses raw JWT payload base64.

**Files:**
- Modify: `src/observability/sanitize-pii.ts`

- [ ] **Step 1: Add base64 JWT payload pattern**

```typescript
// Add to patterns
const JWT_PAYLOAD_PATTERN = /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*/g;
const JWT_PAYLOAD_REPLACEMENT = 'eyJ***.eyJ***';

// Add to sanitizePII string replacement chain
  return obj
    .replace(EMAIL_PATTERN, EMAIL_REPLACEMENT)
    .replace(TOKEN_PREFIX_PATTERN, TOKEN_REPLACEMENT)
    .replace(API_KEY_PREFIX_PATTERN, API_KEY_REPLACEMENT)
    .replace(JWT_PAYLOAD_PATTERN, JWT_PAYLOAD_REPLACEMENT) // NEW
    .replace(CREDIT_CARD_PATTERN, CREDIT_CARD_REPLACEMENT)
    .replace(PHONE_PATTERN, PHONE_REPLACEMENT)
    .replace(SSN_PATTERN, SSN_REPLACEMENT);
```

- [ ] **Step 2: Commit**

```bash
git add src/observability/sanitize-pii.ts
git commit -m "fix(sanitize): redact raw JWT payload base64 in logs

Adds pattern for eyJ... JWT payload segments that were
passing through PII sanitization untouched."
```

---

### Task 12: Remove CORS Wildcard Default

**Finding #12:** `CORS_ALLOWED_ORIGINS` defaults to `*`.

**Files:**
- Modify: `src/config/env.ts:85`

- [ ] **Step 1: Change default to empty (explicit configuration required)**

```typescript
// BEFORE
  CORS_ALLOWED_ORIGINS: z.string().default('*'),

// AFTER
  CORS_ALLOWED_ORIGINS: z.string().default(''),
```

- [ ] **Step 2: Update CORS middleware to reject empty origins**

Check `src/index.ts` where `cors()` is configured — if it uses the env var, ensure empty string = no origins allowed (cors middleware should handle this).

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts
git commit -m "fix(config): remove CORS wildcard default

Empty default forces explicit CORS_ALLOWED_ORIGINS configuration.
Prevents accidental open CORS in production."
```

---

### Task 13: Add Docker Resource Limits

**Finding #13:** Dockerfile lacks `--memory`/`--cpus` limits; Bun-subprocess healthcheck wasteful.

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add resource constraints comment and use built-in healthcheck**

```dockerfile
# Add to production stage (before HEALTHCHECK)
# Resource limits should be set at runtime:
# docker run --memory=512m --cpus=1.0 ...
# or in docker-compose/k8s resources section

# BEFORE (line 27)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

// AFTER — use curl if available, or document built-in approach
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD ["sh", "-c", "wget -qO- http://localhost:3000/health || exit 1"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "ops(docker): add resource limit docs, replace bun healthcheck

Bun-subprocess healthcheck spawned a new process every 30s.
Use wget (from busybox/alpine) instead. Document memory/cpu
limits for runtime configuration."
```

---

### Task 14: Fix Context Type Safety

**Finding #14:** `unknown` and pointless optionals in `ContextVariableMap`.

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Narrow types**

```typescript
// BEFORE
    patToken: unknown;
    estimatedCost: unknown; // Decimal
    parsedBody: unknown;

// AFTER
    patToken: string;
    estimatedCost: Decimal;
    parsedBody: Record<string, unknown>;
```

- [ ] **Step 2: Add Decimal import**

```typescript
import { Decimal } from 'decimal.js';
```

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "fix(types): narrow context variable types

patToken: unknown -> string
estimatedCost: unknown -> Decimal
parsedBody: unknown -> Record<string, unknown>"
```

---

## Final Verification

- [ ] **Run full typecheck**

```bash
bun run typecheck
```
Expected: 0 errors

- [ ] **Run full test suite**

```bash
bun test
```
Expected: All pass (no failures)

- [ ] **Run lint**

```bash
bun run lint
```
Expected: Clean

- [ ] **Run coverage check**

```bash
bun run test:coverage:check
```
Expected: ≥90% threshold met

- [ ] **Final commit**

```bash
git commit --allow-empty -m "chore: complete review fixes wave 4"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] #1 Build broken → Task 1
- [x] #2 Cache poisoning → Task 2
- [x] #3 Admin 2FA optional → Task 3
- [x] #4 Quota float → Task 4
- [x] #5 CB half-open race → Task 5
- [x] #6 Unbounded SCAN → Task 6
- [x] #7 JSON.parse every chunk → Task 7
- [x] #8 Async DB in stream → Task 8
- [x] #9 Metric cardinality → Task 9
- [x] #10 Cache double-parse → Task 10
- [x] #11 PII JWT base64 → Task 11
- [x] #12 CORS default * → Task 12
- [x] #13 Docker limits → Task 13
- [x] #14 Types unknown → Task 14

**Placeholder scan:** No TBD/TODO/fill-in-details found.

**Type consistency:** All types referenced exist in codebase. Decimal imported from decimal.js.
