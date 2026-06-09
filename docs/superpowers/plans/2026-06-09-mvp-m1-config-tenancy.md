# MVP M1 — Table Storage Config + Tenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace M0's static seed allowlist with Table Storage–backed config and tenancy resolution: model/pricing registry, principal→project mapping, budget policy, and tiered L1/L2 read-through with version-bust — so `tenant-context` resolves real allowlist/budget and deny-by-default applies on missing policy.

**Architecture:** `kernel/config-store/` owns entity shapes + provider interface (in-memory for tests/compose; `@azure/data-tables` for prod). `pipeline/tenant-context.ts` resolves `TenantContext` from `UserAuth` via the cached config store. M1 resolves policy only; Redis budget enforcement lands in M2. Legacy `legacy/src/config/deployments.ts` + `pricing.json` inform the code seed, not a port.

**Tech Stack:** Node 24 · TypeScript · `@azure/data-tables` · vitest · in-memory L1 cache · optional ioredis L2 (stub interface in M1, wired in M2).

**Reference:** ADR-0011 (Table entities + cache), ADR-0013 (budget policy fail-closed), M0 emitted interfaces (`UserAuth`, `PRINCIPAL_HEADERS`, auth pipeline).

---

## File structure (M1)

```
contracts/
  model-config.schema.json          # neutral model row shape
packages/shared/src/
  contracts/tenant.ts               # TenantContext, ModelConfig, BudgetPolicy, PrincipalRecord
services/gateway/src/
  kernel/config-store/
    types.ts                        # ConfigStore interface
    memory-store.ts                 # in-memory Table Storage stand-in + seed bootstrap
    table-store.ts                  # @azure/data-tables adapter
    cache.ts                        # L1 read-through wrapper (+ L2 hook)
    seed.ts                         # code seed from legacy deployment registry (MVP models only)
  pipeline/
    tenant-context.ts               # resolve TenantContext; fail-closed on missing budget
    tenant-context.test.ts
  config/seed.ts                    # deprecated → re-export from kernel/config-store/seed
  app.ts                            # wire tenant-context; drop static allowlist dep
  types.ts                          # add tenantContext to ContextVariableMap
```

---

### Task 1: Shared tenant + config types

**Files:**
- Create: `packages/shared/src/contracts/tenant.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write failing test** `services/gateway/src/kernel/config-store/types.test.ts` importing shared types
- [ ] **Step 2: Create tenant.ts** with `ModelConfig`, `BudgetPolicy`, `PrincipalRecord`, `TenantContext`
- [ ] **Step 3: Export from packages/shared index**
- [ ] **Step 4: Run** `cd services/gateway && yarn test src/kernel/config-store/types.test.ts`
- [ ] **Step 5: Commit** `feat(shared): tenant + config entity types (M1 ADR-0011)`

---

### Task 2: Config store interface + in-memory provider + code seed

**Files:**
- Create: `services/gateway/src/kernel/config-store/types.ts`
- Create: `services/gateway/src/kernel/config-store/seed.ts`
- Create: `services/gateway/src/kernel/config-store/memory-store.ts`
- Create: `services/gateway/src/kernel/config-store/memory-store.test.ts`

- [ ] **Step 1: Write failing tests** for seed bootstrap + getModel/getPrincipal/getBudgetPolicy
- [ ] **Step 2: Implement** memory store with deny-by-default (unknown principal → empty allowlist, null budget)
- [ ] **Step 3: Seed** MVP models from legacy registry subset (gpt-5.4, gpt-5-mini, claude-opus-4-6, claude-haiku-4-5) + compose e2e principals
- [ ] **Step 4: Run tests** — all green
- [ ] **Step 5: Commit** `feat(gateway): in-memory config store + code seed (M1)`

---

### Task 3: L1 read-through cache + version bust

**Files:**
- Create: `services/gateway/src/kernel/config-store/cache.ts`
- Create: `services/gateway/src/kernel/config-store/cache.test.ts`

- [ ] **Step 1: Write failing tests** for L1 TTL hit/miss + version bust invalidates
- [ ] **Step 2: Implement** CachedConfigStore wrapping ConfigStore (1 min TTL default)
- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit** `feat(gateway): L1 config cache + version bust (M1 ADR-0011)`

---

### Task 4: tenant-context pipeline middleware

**Files:**
- Create: `services/gateway/src/pipeline/tenant-context.ts`
- Create: `services/gateway/src/pipeline/tenant-context.test.ts`

- [ ] **Step 1: Write failing tests** — resolves allowlist from store; missing budget → 403 fail-closed; empty allowlist → 403
- [ ] **Step 2: Implement** tenantContextMiddleware(configStore)
- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit** `feat(gateway): tenant-context middleware (M1)`

---

### Task 5: Wire app + replace static allowlist

**Files:**
- Modify: `services/gateway/src/app.ts`, `services/gateway/src/types.ts`, `services/gateway/src/server.ts`
- Modify: `services/gateway/src/pipeline/scope.ts` (read from tenantContext)
- Modify: `services/gateway/src/app.e2e.test.ts`

- [ ] **Step 1: Update AppDeps** — configStore instead of allowlist
- [ ] **Step 2: Pipeline order** auth → tenant-context → protocol-guard → scope
- [ ] **Step 3: Update e2e tests** to use memory store seed
- [ ] **Step 4: Run** `yarn test && yarn typecheck`
- [ ] **Step 5: Commit** `feat(gateway): wire tenant-context into app (M1)`

---

### Task 6: contracts/model-config.schema.json

**Files:**
- Create: `contracts/model-config.schema.json`

- [ ] **Step 1: Create JSON schema** matching ModelConfig fields
- [ ] **Step 2: Commit** `docs(contracts): model-config.schema.json (M1)`

---

### Task 7: Azure Table Storage adapter (env-gated)

**Files:**
- Create: `services/gateway/src/kernel/config-store/table-store.ts`
- Create: `services/gateway/src/kernel/config-store/table-store.test.ts` (mock @azure/data-tables)
- Modify: `services/gateway/package.json` (add `@azure/data-tables`)
- Modify: `services/gateway/src/server.ts` (CONFIG_STORE=memory|table)

- [ ] **Step 1: Write tests** with mocked TableClient
- [ ] **Step 2: Implement** TableConfigStore
- [ ] **Step 3: server.ts** selects store by env (default memory for compose)
- [ ] **Step 4: Commit** `feat(gateway): Azure Table Storage config adapter (M1)`

---

### Task 8: Whole-repo verification

- [ ] **Step 1:** `cd services/gateway && yarn test && yarn typecheck`
- [ ] **Step 2:** `cd services/edge && dotnet test`
- [ ] **Step 3:** compose e2e still passes with memory store
- [ ] **Step 4:** Update AGENTS.md M1 section if needed

---

## M1 done-criteria

- Model config served from config store (memory in compose; Table in prod path)
- `tenant-context` resolves allowlist + budget policy per principal
- Unknown model → 403; missing budget policy → 403 fail-closed
- L1 cache + version bust tested
- All M0 tests still green + new M1 tests green
