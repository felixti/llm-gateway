# MVP M2 — Budget + Rate Limit on Redis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** Enforce per-principal USD budget (Redis Lua reserve×1.2/commit/release) and RPM/TPM rate limits on the gateway hot path, with policy synced from config store to Redis and fail-closed when Redis/policy is missing.

**Architecture:** `packages/shared` holds budget key helpers + microdollar math. `kernel/budget-store` and `kernel/rate-store` wrap ioredis with ADR-0013 hash-tag keys. `pipeline/budget` + `pipeline/rate-limit` sit after scope, before handlers. Stub routes commit estimated cost post-response. Compose stack gains Redis.

**Tech Stack:** ioredis · ioredis-mock (unit tests) · decimal.js · vitest · Redis 7 in compose.

**Reference:** ADR-0013 (single-scope hash tags), legacy `legacy/src/services/quota/` (behavior reference, rewrite not port).

---

## File structure

```
packages/shared/src/
  budget/keys.ts          # {user:oid} / {proj:id} hash tags + key names
  budget/money.ts         # microdollar conversion
services/gateway/src/
  kernel/budget-store/
    scripts.ts            # RESERVE / COMMIT / RELEASE Lua
    store.ts              # BudgetStore interface + createBudgetStore
    store.test.ts
  kernel/rate-store/
    store.ts              # RPM/TPM single-key sliding minute window
    store.test.ts
  kernel/policy-sync.ts   # push cap/hard from BudgetPolicy → Redis policy hash
  utils/tokens.ts         # estimate tokens (char/4 + overhead for M2)
  utils/pricing.ts        # cost from ModelConfig + token counts
  pipeline/rate-limit.ts
  pipeline/budget.ts
  pipeline/budget.test.ts
  pipeline/rate-limit.test.ts
deploy/compose/docker-compose.yml  # add redis service + gateway env
```

---

### Task 1: Shared budget keys + microdollars

Create `packages/shared/src/budget/keys.ts`, `money.ts`, export from index.
Tests in gateway importing shared types.

Commit: `feat(shared): budget hash-tag keys + microdollars (M2 ADR-0013)`

---

### Task 2: Budget store Lua + implementation

- RESERVE: check cap, incr reserved, set resv key with TTL
- COMMIT: idempotent via commit:request_id, move reserved→spent
- RELEASE: decr reserved, del resv
- All keys under one `{scope}` hash tag

Commit: `feat(gateway): budget store Lua reserve/commit/release (M2)`

---

### Task 3: Rate store (RPM/TPM)

Single-key INCR per minute window under `{scope}:rpm:{minute}` / `{scope}:tpm:{minute}`.
Fail-closed when over limit → 429.

Commit: `feat(gateway): rate store RPM/TPM (M2 ADR-0013)`

---

### Task 4: Token estimate + pricing utils

`estimateRequestTokens(body, family)` and `estimateCost(model, tokens)`.
Reserve multiplier 1.2 from env default.

Commit: `feat(gateway): token estimate + pricing utils (M2)`

---

### Task 5: Policy sync to Redis

`syncBudgetPolicy(redis, scopeTag, policy)` writes `{scope}:policy` hash.
Called at reserve time from tenantContext.budgetPolicy.

Commit: `feat(gateway): sync budget policy to Redis (M2)`

---

### Task 6: rate-limit + budget pipeline middleware

Wire after scope, before handler.
Set context vars: reservationId, budgetScopeTag.
429 on rate limit or over-cap.

Commit: `feat(gateway): budget + rate-limit pipeline middleware (M2)`

---

### Task 7: Wire app + stub commit + compose Redis

- Update app.ts pipeline order
- Stub handlers commit budget after 200
- Add redis service to compose; REDIS_URL on gateway
- Seed generous caps in policy sync for e2e principals

Commit: `feat(gateway): wire budget/rate-limit + compose Redis (M2)`

---

### Task 8: Verification

- `yarn test && yarn typecheck` in gateway
- `dotnet test` edge
- compose e2e passes

---

## M2 done-criteria

- Reserve×1.2 before stub handler; over-cap → 429
- RPM/TPM enforced per principal scope
- Fail-closed without Redis policy
- Compose e2e still green with Redis
