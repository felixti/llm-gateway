# Four High-Priority Bugs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 production bugs: soft-quota false reject, Foundry health-check URL mismatch, Anthropic non-streaming JSON parse leak, Docker Compose healthcheck curl dependency.

**Architecture:** Four independent fixes, parallelizable. Bug 1 (quota) and Bug 3 (anthropic proxy) share a pattern (quota release on error) but touch different files. Bug 2 (health URL) needs an import from deployments config. Bug 4 (docker-compose) is a one-liner config change.

**Tech Stack:** Bun/Hono, TypeScript, Bun test runner, Biome lint, Docker Compose

---

## Task Dependency Graph

```
Bug 1 (quota)  ──────────┐
Bug 2 (health URL) ───────┤──→ Final verification
Bug 3 (anthropic proxy) ──┤
Bug 4 (docker-compose) ───┘
```

All four tasks are **independent** — none depend on each other. They can be executed in parallel.

---

## File Impact Map

| File | Bug 1 | Bug 2 | Bug 3 | Bug 4 |
|------|:-----:|:-----:|:-----:|:-----:|
| `src/middleware/quota.ts` | M | | | |
| `src/services/quota.service.ts` | | | | |
| `src/services/health.service.ts` | | M | | |
| `src/config/deployments.ts` | | M | | |
| `src/proxy/anthropic.proxy.ts` | | | M | |
| `src/proxy/openai-chat.proxy.ts` | | R | R | |
| `docker-compose.yml` | | | | M |
| `tests/unit/middleware/quota.test.ts` | M | | | |
| `tests/unit/services/health.service.test.ts` | | M | | |
| `tests/unit/proxy/anthropic.proxy.test.ts` | | | M | |

M = Modify, R = Read (for reference patterns only)

---

## Bug 1: Soft Quota Still Rejects Through checkAndReserve

**Root cause:** `quota.ts:127-129` — When `wouldExceedBudget && !isHardLimit`, the middleware sets the `X-Warning` header but falls through to `checkAndReserve()`. The Lua script in `quota.service.ts:78-80` always enforces `spent + reserved + cost > budget` → returns `{0, 'insufficient_quota'}` → 429.

**Fix:** When soft limit is exceeded, skip `checkAndReserve()` entirely. Set `releaseQuota` to a no-op (no reservation made), set headers for visibility, and call `next()`.

### Task 1: Fix soft quota bypass in quota middleware

**Files:**
- Modify: `src/middleware/quota.ts:115-170`
- Modify: `tests/unit/middleware/quota.test.ts`

- [ ] **Step 1: Write failing tests for soft-limit bypass**

Add to `tests/unit/middleware/quota.test.ts`:

```typescript
import { beforeEach, describe, expect, test, vi } from 'bun:test';
import { Decimal } from 'decimal.js';
import type { Context, Next } from 'hono';

const mockCalculateEstimatedCost = vi.fn();
const mockCheckAndReserve = vi.fn();
const mockGetQuotaStatus = vi.fn();
const mockReleaseReservation = vi.fn();
const mockReconcileUsage = vi.fn();

vi.mock('../../../src/services/pricing.service', () => ({
  calculateEstimatedCost: (...args: unknown[]) => mockCalculateEstimatedCost(...args),
}));

vi.mock('../../../src/services/quota.service', () => ({
  checkAndReserve: (...args: unknown[]) => mockCheckAndReserve(...args),
  getQuotaStatus: (...args: unknown[]) => mockGetQuotaStatus(...args),
  releaseReservation: (...args: unknown[]) => mockReleaseReservation(...args),
  reconcileUsage: (...args: unknown[]) => mockReconcileUsage(...args),
}));

function createMockContext(overrides: Record<string, unknown> = {}): Context {
  const vars = new Map<string, unknown>([
    ['userId', 'user-1'],
    ['model', 'gpt-5.4'],
    ['parsedBody', { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 }],
    ...Object.entries(overrides),
  ]);

  const headers: Record<string, string> = {};

  const context = {
    req: {
      path: '/v1/chat/completions',
      json: async () => ({}),
    },
    get: (key: string) => vars.get(key),
    set: (key: string, value: unknown) => {
      vars.set(key, value);
    },
    header: (name?: string, value?: string) => {
      if (name && value !== undefined) {
        headers[name] = value;
        return;
      }
      if (name) return headers[name];
      return headers;
    },
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status }),
    res: new Response(null, { status: 200 }),
  };

  return context as unknown as Context;
}

describe('quotaMiddleware — soft limit', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.PAT_SECRET = 'test-secret-that-is-at-least-32-chars!!';
    process.env.QUOTA_SOFT_LIMIT_ENABLED = 'true';
    mockCalculateEstimatedCost.mockReset();
    mockCheckAndReserve.mockReset();
    mockGetQuotaStatus.mockReset();
    mockReleaseReservation.mockReset();
  });

  test('soft-limit over-budget request skips reservation and calls next()', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    mockGetQuotaStatus.mockResolvedValue({
      monthly_budget_usd: 10,
      spent_usd: 9.5,
      reserved_usd: 1,
      remaining_usd: 0,
      reset_date: '2026-06-01',
      hard_limit: false,
    });

    mockCalculateEstimatedCost.mockReturnValue(new Decimal('0.50'));

    const next = vi.fn(async () => undefined) as Next;
    const ctx = createMockContext();

    const response = await quotaMiddleware(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(mockCheckAndReserve).not.toHaveBeenCalled();
    expect(ctx.header('X-Warning')).toBe('Soft quota limit exceeded. Usage is being tracked.');
  });

  test('soft-limit request sets releaseQuota to no-op when skipping reservation', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    mockGetQuotaStatus.mockResolvedValue({
      monthly_budget_usd: 10,
      spent_usd: 9.5,
      reserved_usd: 1,
      remaining_usd: 0,
      reset_date: '2026-06-01',
      hard_limit: false,
    });

    mockCalculateEstimatedCost.mockReturnValue(new Decimal('0.50'));

    const next = vi.fn(async () => undefined) as Next;
    const ctx = createMockContext();

    await quotaMiddleware(ctx, next);

    const releaseQuota = ctx.get('releaseQuota');
    expect(typeof releaseQuota).toBe('function');
    await (releaseQuota as () => Promise<void>)();
    expect(mockReleaseReservation).not.toHaveBeenCalled();
  });
});

describe('quotaMiddleware — hard limit', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.PAT_SECRET = 'test-secret-that-is-at-least-32-chars!!';
    process.env.QUOTA_SOFT_LIMIT_ENABLED = 'false';
    mockCalculateEstimatedCost.mockReset();
    mockCheckAndReserve.mockReset();
    mockGetQuotaStatus.mockReset();
    mockReleaseReservation.mockReset();
  });

  test('hard-limit over-budget request returns 429', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    mockGetQuotaStatus.mockResolvedValue({
      monthly_budget_usd: 10,
      spent_usd: 9.5,
      reserved_usd: 1,
      remaining_usd: 0,
      reset_date: '2026-06-01',
      hard_limit: true,
    });

    mockCalculateEstimatedCost.mockReturnValue(new Decimal('0.50'));

    const next = vi.fn(async () => undefined) as Next;
    const ctx = createMockContext();

    const response = await quotaMiddleware(ctx, next);

    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(429);
    expect(next).not.toHaveBeenCalled();
    expect(mockCheckAndReserve).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/middleware/quota.test.ts`
Expected: FAIL — soft-limit test calls `next()` through to `checkAndReserve` which rejects, or `X-Warning` is set but request still gets 429.

- [ ] **Step 3: Implement the fix in quota.ts**

Replace the soft-limit block in `src/middleware/quota.ts`. The current code at lines ~115-130:

```typescript
if (wouldExceedBudget && !isHardLimit) {
  c.header(HEADER_WARNING, 'Soft quota limit exceeded. Usage is being tracked.');
}

const reservation = await checkAndReserve(userId, estimatedCost);

if (!reservation.allowed) {
  const error = errorForProtocol(
    path,
    429,
    'quota_exceeded',
    reservation.reason || 'Quota reservation failed'
  );
  incrementQuotaExceeded429();
  return c.json(error, 429);
}
```

Replace with:

```typescript
if (wouldExceedBudget && !isHardLimit) {
  c.header(HEADER_WARNING, 'Soft quota limit exceeded. Usage is being tracked.');

  c.set('releaseQuota', async () => {});
  c.set('reservationId', '');
  c.set('estimatedCost', estimatedCost);

  const budget = quotaStatus.monthly_budget_usd;
  if (budget > 0) {
    setQuotaRemainingRatio(0);
  }
  c.header(HEADER_QUOTA_REMAINING, '0');
  c.header(HEADER_QUOTA_RESERVED, '');

  await next();
  return;
}

const reservation = await checkAndReserve(userId, estimatedCost);

if (!reservation.allowed) {
  const error = errorForProtocol(
    path,
    429,
    'quota_exceeded',
    reservation.reason || 'Quota reservation failed'
  );
  incrementQuotaExceeded429();
  return c.json(error, 429);
}
```

Key changes:
1. After setting `X-Warning`, set `releaseQuota` to an async no-op (no reservation to release)
2. Set `reservationId` to empty string, `estimatedCost` for downstream visibility
3. Set remaining ratio to 0 (over budget)
4. Set quota headers
5. Call `next()` and return — skip `checkAndReserve()` entirely

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/middleware/quota.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/middleware/quota.ts tests/unit/middleware/quota.test.ts
git commit -m "fix(quota): soft-limit requests bypass reservation instead of 429

When QUOTA_SOFT_LIMIT_ENABLED=true and wouldExceedBudget, middleware now
skips checkAndReserve(), sets X-Warning header, and calls next(). Previously
the Lua script still enforced the budget hard, causing soft-limit users to
receive 429 errors."
```

---

## Bug 2: Foundry Health Check URL Mismatch

**Root cause:** `src/services/health.service.ts:47-48` hardcodes `/openai/deployments/{deployment.name}/chat/completions` for ALL chat-completions deployments. The proxy's `buildUpstreamUrl()` in `src/proxy/openai-chat.proxy.ts:37-41` routes Foundry families (`kimi`, `glm`, `minimax`) to `/models/chat/completions`.

**Fix approach:** Option A — Import `FOUNDRY_FAMILIES` from deployments config and add a branch in `checkChatCompletionsHealth()`. This is the minimal change. The `FOUNDRY_FAMILIES` constant is currently local to `openai-chat.proxy.ts`; we'll extract it to `deployments.ts` where it belongs conceptually.

### Task 2: Fix Foundry health check URL

**Files:**
- Modify: `src/config/deployments.ts` (export `FOUNDRY_FAMILIES`)
- Modify: `src/proxy/openai-chat.proxy.ts` (import `FOUNDRY_FAMILIES` from config)
- Modify: `src/services/health.service.ts` (use foundry URL for foundry families)
- Modify: `tests/unit/services/health.service.test.ts`

- [ ] **Step 1: Write failing test for Foundry health check URL**

Add to `tests/unit/services/health.service.test.ts`:

```typescript
const foundryDeployment: DeploymentConfig = {
  name: 'kimi-k2.5',
  modelAlias: 'kimi-k2.5',
  modelFamily: 'kimi',
  protocolFamily: 'chat-completions',
  azureModelName: 'FW-Kimi-K2.5',
  endpoint: 'https://example.foundry.azure.com',
  authConfig: { type: 'api-key', apiKey: 'test-key', keyHeader: 'api-key' },
  apiVersion: '2024-06-01',
  enabled: true,
};

describe('checkDeploymentHealth — Foundry URL', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses /models/chat/completions path for Foundry model families', async () => {
    let capturedUrl = '';
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === 'string' ? input : input.toString();
        return new Response('{}', { status: 200 });
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    await checkDeploymentHealth(foundryDeployment);

    expect(capturedUrl).toContain('/models/chat/completions');
    expect(capturedUrl).not.toContain('/openai/deployments/');
  });

  it('uses /openai/deployments/ path for standard Azure OpenAI models', async () => {
    let capturedUrl = '';
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === 'string' ? input : input.toString();
        return new Response('{}', { status: 200 });
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    await checkDeploymentHealth(deployment);

    expect(capturedUrl).toContain('/openai/deployments/gpt-5.4-global/chat/completions');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/services/health.service.test.ts`
Expected: FAIL — Foundry deployment uses `/openai/deployments/kimi-k2.5/chat/completions` instead of `/models/chat/completions`

- [ ] **Step 3: Extract FOUNDRY_FAMILIES to deployments.ts**

In `src/config/deployments.ts`, add before the `DEPLOYMENTS` array:

```typescript
export const FOUNDRY_FAMILIES: ModelFamily[] = ['kimi', 'glm', 'minimax'];
```

In `src/proxy/openai-chat.proxy.ts`, replace the local constant with an import:

```typescript
import { FOUNDRY_FAMILIES } from '@/config/deployments';
```

Remove:
```typescript
const FOUNDRY_FAMILIES = ['kimi', 'glm', 'minimax'];
```

- [ ] **Step 4: Update health.service.ts to use foundry URL for foundry families**

In `src/services/health.service.ts`, add import:

```typescript
import {
  type DeploymentConfig,
  FOUNDRY_FAMILIES,
  getAllDeployments,
  getDeploymentByAlias,
} from '@/config/deployments';
```

Replace `checkChatCompletionsHealth` function body. The current URL construction:

```typescript
const url = new URL(deployment.endpoint);
url.pathname = `/openai/deployments/${deployment.name}/chat/completions`;
url.searchParams.set('api-version', deployment.apiVersion);
```

Replace with:

```typescript
const url = new URL(deployment.endpoint);

if (FOUNDRY_FAMILIES.includes(deployment.modelFamily)) {
  url.pathname = '/models/chat/completions';
} else {
  url.pathname = `/openai/deployments/${deployment.name}/chat/completions`;
}

url.searchParams.set('api-version', deployment.apiVersion);
```

Compare this to `buildUpstreamUrl()` in `openai-chat.proxy.ts:37-41`:

```typescript
if (FOUNDRY_FAMILIES.includes(modelFamily)) {
  return `${endpoint}/models/chat/completions?api-version=${apiVersion}`;
}
return `${endpoint}/openai/deployments/${name}/chat/completions?api-version=${apiVersion}`;
```

The health check now matches the proxy's URL routing logic exactly.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/services/health.service.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/config/deployments.ts src/proxy/openai-chat.proxy.ts src/services/health.service.ts tests/unit/services/health.service.test.ts
git commit -m "fix(health): use Foundry URL path for kimi/glm/minimax health checks

Extract FOUNDRY_FAMILIES to deployments config. Health checks for Foundry
models now use /models/chat/completions matching the proxy's buildUpstreamUrl,
instead of /openai/deployments/{name}/chat/completions which returns 404."
```

---

## Bug 3: Anthropic Proxy Non-Streaming JSON Parse Leaks Reservations

**Root cause:** `src/proxy/anthropic.proxy.ts:82-85` — `proxyNonStreamingAnthropic()` does bare `await response.json()` with no content-type validation, no try/catch, and no quota release on parse failure. The OpenAI proxy (`src/proxy/openai-chat.proxy.ts:107-133`) has all three defenses.

**Fix:** Mirror the OpenAI proxy's defensive pattern: validate content-type, wrap JSON parse in try/catch, release reservation + recordFailure + return sanitized 502 on failure.

### Task 3: Add defensive JSON parsing to Anthropic non-streaming proxy

**Files:**
- Modify: `src/proxy/anthropic.proxy.ts:70-100`
- Modify: `tests/unit/proxy/anthropic.proxy.test.ts`

- [ ] **Step 1: Write failing tests for non-JSON and malformed-JSON responses**

Add to `tests/unit/proxy/anthropic.proxy.test.ts` inside the `proxyNonStreamingAnthropic` describe block:

```typescript
it('releases reservation and returns 502 on non-JSON content-type', async () => {
  global.fetch = vi.fn(async () =>
    new Response('not json', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as unknown as typeof fetch;

  mockReleaseReservation.mockResolvedValue(undefined);
  mockRecordFailure.mockResolvedValue(undefined);

  const response = await proxyNonStreamingAnthropic(
    'https://test.azure.com/messages',
    {},
    { model: 'claude-test', messages: [], max_tokens: 100 },
    baseDeployment,
    { reservationId: 'res-bad-ct', requestId: 'req-bad-ct', userId: 'user-123' }
  );

  expect(response.status).toBe(502);
  expect(mockReleaseReservation).toHaveBeenCalledWith('res-bad-ct');
  expect(mockRecordFailure).toHaveBeenCalledWith('claude-test');

  const body = (await response.json()) as { error: { message: string } };
  expect(body.error.message).toContain('Azure AI Foundry upstream request failed');
});

it('releases reservation and returns 502 on malformed JSON response', async () => {
  global.fetch = vi.fn(async () =>
    new Response('{not valid json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  mockReleaseReservation.mockResolvedValue(undefined);
  mockRecordFailure.mockResolvedValue(undefined);

  const response = await proxyNonStreamingAnthropic(
    'https://test.azure.com/messages',
    {},
    { model: 'claude-test', messages: [], max_tokens: 100 },
    baseDeployment,
    { reservationId: 'res-bad-json', requestId: 'req-bad-json', userId: 'user-123' }
  );

  expect(response.status).toBe(502);
  expect(mockReleaseReservation).toHaveBeenCalledWith('res-bad-json');
  expect(mockRecordFailure).toHaveBeenCalledWith('claude-test');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/proxy/anthropic.proxy.test.ts`
Expected: FAIL — non-JSON content-type test gets 200 instead of 502; malformed JSON test throws unhandled parse error.

- [ ] **Step 3: Add content-type validation and try/catch in anthropic.proxy.ts**

Replace the section of `proxyNonStreamingAnthropic` after `await recordSuccess(deployment.name);` (currently lines ~80-85):

```typescript
// Current (buggy):
const responseBody = (await response.json()) as {
  type?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: TokenUsage;
  error?: { type: string; message: string };
};
```

Replace with:

```typescript
const contentType = response.headers.get('content-type') || '';
if (!contentType.includes('application/json')) {
  await recordFailure(deployment.name);
  await releaseReservedQuota(reservationId, requestId);
  return createSanitizedUpstreamErrorResponse({
    response,
    path: '/v1/messages',
    errorCode: 'api_error',
    upstreamName: 'Azure AI Foundry',
    requestId,
    deploymentName: deployment.name,
  });
}

let responseBody: {
  type?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: TokenUsage;
  error?: { type: string; message: string };
};

try {
  responseBody = (await response.json()) as typeof responseBody;
} catch (parseError) {
  logger.warn({ err: parseError, requestId }, 'Failed to parse upstream JSON response');
  await recordFailure(deployment.name);
  await releaseReservedQuota(reservationId, requestId);
  return createSanitizedUpstreamErrorResponse({
    response,
    path: '/v1/messages',
    errorCode: 'api_error',
    upstreamName: 'Azure AI Foundry',
    requestId,
    deploymentName: deployment.name,
  });
}
```

This mirrors the pattern from `openai-chat.proxy.ts:107-133` exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/proxy/anthropic.proxy.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/proxy/anthropic.proxy.ts tests/unit/proxy/anthropic.proxy.test.ts
git commit -m "fix(anthropic): add content-type validation and JSON parse safety to non-streaming proxy

Mirror OpenAI proxy's defensive pattern: validate content-type before parsing,
wrap response.json() in try/catch, and release reservation + recordFailure +
return sanitized 502 on failure. Previously a non-JSON or malformed upstream
response would leak the quota reservation."
```

---

## Bug 4: Docker Compose Healthcheck Uses curl

**Root cause:** `docker-compose.yml:49` uses `curl -f http://localhost:3000/health` but `oven/bun:1.2` image doesn't include `curl`. The Dockerfile correctly uses `bun -e "fetch(...)"`.

**Fix:** Replace `CMD curl` with `CMD-SHELL bun -e` matching the Dockerfile pattern.

### Task 4: Fix Docker Compose healthcheck

**Files:**
- Modify: `docker-compose.yml:48-51`

- [ ] **Step 1: Replace curl healthcheck with bun-native healthcheck**

In `docker-compose.yml`, replace lines 48-51:

```yaml
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

With:

```yaml
    healthcheck:
      test: ["CMD-SHELL", "bun -e \"fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))\""]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 5s
```

This matches the Dockerfile's `HEALTHCHECK` command exactly (line 27-28):

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
```

- [ ] **Step 2: Validate compose config**

Run: `docker compose config --quiet`
Expected: No errors (if docker compose is available). If not available, verify YAML syntax manually.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "fix(docker): replace curl healthcheck with bun-native fetch

The oven/bun:1.2 image doesn't include curl. Use the same bun -e fetch
command that the Dockerfile uses for its HEALTHCHECK, ensuring consistency
and eliminating the missing dependency failure."
```

---

## Final Verification

After all four tasks are complete:

- [ ] **Run full test suite**

```bash
bun test --coverage
```

Expected: All tests pass, coverage ≥ 85%.

- [ ] **Run type checking**

```bash
bun run typecheck
```

Expected: No errors.

- [ ] **Run linting**

```bash
bun run lint
```

Expected: No errors.

- [ ] **Run CI pipeline**

```bash
bun run lint && bun run typecheck && bun run test:coverage:check
```

Expected: All pass.

---

## Commit Strategy

Four atomic commits, one per bug. Order doesn't matter since they're independent.

| # | Commit Message | Files Changed |
|---|---------------|---------------|
| 1 | `fix(quota): soft-limit requests bypass reservation instead of 429` | `src/middleware/quota.ts`, `tests/unit/middleware/quota.test.ts` |
| 2 | `fix(health): use Foundry URL path for kimi/glm/minimax health checks` | `src/config/deployments.ts`, `src/proxy/openai-chat.proxy.ts`, `src/services/health.service.ts`, `tests/unit/services/health.service.test.ts` |
| 3 | `fix(anthropic): add content-type validation and JSON parse safety to non-streaming proxy` | `src/proxy/anthropic.proxy.ts`, `tests/unit/proxy/anthropic.proxy.test.ts` |
| 4 | `fix(docker): replace curl healthcheck with bun-native fetch` | `docker-compose.yml` |