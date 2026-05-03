# LLM Gateway 9+ Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the gateway from strong test coverage to production-grade behavior under unsafe config, upstream failure, quota drift, PAT revocation, and long streaming workloads.

**Architecture:** Keep behavior changes narrow and contract-tested. Harden startup boundaries first, then split high-risk quota and streaming logic into smaller pure helpers with focused tests. Preserve protocol-specific proxy behavior while extracting only shared lifecycle mechanics.

**Tech Stack:** Bun, Hono, TypeScript, Redis Lua scripts, PostgreSQL, Decimal.js, OpenTelemetry

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/config/env.ts` | Production startup guardrails and typed env parsing |
| `src/proxy/shared.ts` | Sanitized upstream error responses and shared quota release helpers |
| `src/proxy/openai-chat.proxy.ts` | OpenAI/Foundry chat proxy behavior |
| `src/proxy/anthropic.proxy.ts` | Anthropic Messages proxy behavior |
| `src/services/quota.service.ts` | Current quota service to split by responsibility |
| `src/services/quota/*.ts` | Future focused quota modules |
| `src/utils/auth.ts` | PAT generation, parsing, signature, and token contract helpers |
| `src/utils/streaming.ts` | Incremental SSE usage extraction and pass-through transforms |
| `docs/security/pat-contract.md` | Canonical PAT format, scope, and revocation contract |

---

## Task 1: Production Config Guardrails

**Status:** Implemented in this pass.

**Files:**
- Modify: `src/config/env.ts`
- Test: `tests/unit/config/env.test.ts`

- [x] **Step 1: Write failing production validation tests**

Run:
```bash
rtk bun test tests/unit/config/env.test.ts
```

Expected before implementation: fail because `parseEnvForTests` is missing.

- [x] **Step 2: Add production-only validation**

Production config must reject:
- wildcard `CORS_ALLOWED_ORIGINS`
- missing or non-HTTPS Azure OpenAI endpoint
- missing or non-HTTPS Azure AI Foundry endpoint
- missing provider API keys when Entra ID credentials are absent
- default `DATABASE_URL`
- default `REDIS_HOST=localhost`

- [x] **Step 3: Verify focused tests**

Run:
```bash
rtk bun test tests/unit/config/env.test.ts
```

Expected: all env tests pass.

---

## Task 2: Sanitized Upstream Error Responses

**Status:** Implemented in this pass.

**Files:**
- Modify: `src/proxy/openai-chat.proxy.ts`
- Modify: `src/proxy/anthropic.proxy.ts`
- Test: `tests/unit/proxy/openai-chat.proxy.test.ts`
- Test: `tests/unit/proxy/anthropic.proxy.test.ts`

- [x] **Step 1: Write failing leakage tests**

Run:
```bash
rtk bun test tests/unit/proxy/openai-chat.proxy.test.ts tests/unit/proxy/anthropic.proxy.test.ts
```

Expected before implementation: fail because raw provider error bodies are reflected to clients.

- [x] **Step 2: Route proxy failures through `createSanitizedUpstreamErrorResponse`**

Use generic client messages:
- `Azure OpenAI upstream request failed with status N.`
- `Azure AI Foundry upstream request failed with status N.`

Keep provider status, content type, and body length in structured logs.

- [x] **Step 3: Verify focused tests**

Run:
```bash
rtk bun test tests/unit/proxy/openai-chat.proxy.test.ts tests/unit/proxy/anthropic.proxy.test.ts
```

Expected: proxy tests pass and client responses omit provider secrets/details.

---

## Task 3: Split Quota Service by Responsibility

**Files:**
- Create: `src/services/quota/keys.ts`
- Create: `src/services/quota/money.ts`
- Create: `src/services/quota/constants.ts`
- Create: `src/services/quota/policy.ts`
- Create: `src/services/quota/scripts.ts`
- Modify: `src/services/quota.service.ts`
- Test: `tests/unit/services/quota.service.test.ts`
- Test: `tests/unit/services/quota.service.extended.test.ts`
- Test: `tests/unit/services/quota-atomic-operations.test.ts`
- Test: `tests/unit/services/quota-orphan-cleanup.test.ts`

- [x] **Step 1: Extract pure Redis key builders**

Move month/user/reservation key formatting into `src/services/quota/keys.ts`.

Verify:
```bash
rtk bun test tests/unit/services/quota.service.test.ts
```

- [x] **Step 2: Extract policy hydration and Postgres sync**

Move Postgres user budget hydration and Redis policy syncing into `src/services/quota/policy.ts`.

Verify:
```bash
rtk bun test tests/unit/services/quota.service.extended.test.ts
```

- [x] **Step 3: Extract quota constants, money conversion, and Lua scripts**

Move microdollar conversion into `src/services/quota/money.ts`, shared constants into `src/services/quota/constants.ts`, and Lua scripts into `src/services/quota/scripts.ts`.

Verify:
```bash
rtk bun test tests/unit/services/quota-atomic-operations.test.ts
```

- [x] **Step 4: Keep reservation/reconcile behavior behind the public facade**

Keep reservation, release, and reconcile orchestration in `src/services/quota.service.ts` for compatibility while moving lower-level details out.

Verify:
```bash
rtk bun test tests/unit/services/quota.service.test.ts tests/unit/services/quota-orphan-cleanup.test.ts
```

- [x] **Step 5: Keep public compatibility**

Keep `src/services/quota.service.ts` as the public facade exporting the same functions so middleware/proxy imports do not churn.

Verify:
```bash
rtk bun test tests/unit/services/quota.service.test.ts tests/unit/middleware/quota.test.ts
```

---

## Task 4: Lock Down PAT Contract

**Files:**
- Create: `docs/security/pat-contract.md`
- Modify: `src/utils/auth.ts`
- Modify: `src/middleware/auth.ts`
- Modify: `src/routes/admin.routes.ts`
- Test: `tests/unit/utils/auth.test.ts`
- Test: `tests/unit/middleware/auth.test.ts`
- Test: `tests/integration/routes/admin.test.ts`

- [x] **Step 1: Document the canonical contract**

Document:
- token format: `lg_{userId}_{header}.{payload}.{signature}`
- signature algorithm: HMAC-SHA256
- `jti` is the revocation identifier
- Redis blocklist key hashes `jti`
- scopes: `all`, `read`, `admin`, `models:<name>`
- admin revocation requires `scope: admin` and optional operator secret when configured

- [x] **Step 2: Add tests for canonical parse/revoke behavior**

Verify:
```bash
rtk bun test tests/unit/utils/auth.test.ts tests/unit/middleware/auth.test.ts tests/integration/routes/admin.test.ts
```

- [x] **Step 3: Align stale docs/spec text or add an explicit migration note**

Update specs only where they contradict executable behavior, especially old revocation TTL and token prefix variants.

---

## Task 5: Make OpenAI Streaming Constant-Memory

**Files:**
- Modify: `src/utils/streaming.ts`
- Modify: `src/proxy/openai-chat.proxy.ts`
- Test: `tests/unit/utils/streaming.test.ts`
- Test: `tests/unit/provider-contract-fixtures.test.ts`
- Test: `tests/unit/proxy/openai-chat.proxy.test.ts`

- [x] **Step 1: Add an incremental OpenAI usage extractor**

The extractor should accept chunks, preserve pass-through bytes, and return usage as soon as the final usage chunk is parsed. It must not accumulate full response text.

- [x] **Step 2: Replace the `tee()` monitor full-text accumulation**

`proxyStreamingChat` should reconcile quota from incremental usage observation, not `fullText += ...`.

- [x] **Step 3: Add a split-frame incremental regression test**

Use split chunks with a final usage event and assert the observer extracts usage without a complete response string.

Verify:
```bash
rtk bun test tests/unit/utils/streaming.test.ts tests/unit/provider-contract-fixtures.test.ts tests/unit/proxy/openai-chat.proxy.test.ts
```

---

## Task 6: Extract Shared Proxy Lifecycle

**Files:**
- Modify: `src/proxy/shared.ts`
- Modify: `src/proxy/openai-chat.proxy.ts`
- Modify: `src/proxy/anthropic.proxy.ts`
- Test: `tests/unit/proxy/openai-chat.proxy.test.ts`
- Test: `tests/unit/proxy/anthropic.proxy.test.ts`

- [x] **Step 1: Move duplicate context normalization into `src/proxy/shared.ts`**

Use the existing `normalizeProxyContext` helper instead of local copies.

- [x] **Step 2: Move duplicate quota release into `src/proxy/shared.ts`**

Use the existing `releaseReservedQuota` helper instead of local copies.

- [x] **Step 3: Re-run proxy tests after each small extraction**

Verify:
```bash
rtk bun test tests/unit/proxy/openai-chat.proxy.test.ts tests/unit/proxy/anthropic.proxy.test.ts
```

---

## Final Verification

Run:
```bash
rtk bun run lint
rtk bun run typecheck
rtk bun test --coverage
```

Expected:
- lint exits 0
- typecheck exits 0
- tests exit 0
- coverage remains above the project baseline unless the changed surface justifies an explicit note
