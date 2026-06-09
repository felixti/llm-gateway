# HANDOFF — Start MVP M1 implementation (new session)

**Paste this to start the new session:**
> Read `docs/superpowers/plans/2026-06-09-mvp-m1-HANDOFF.md` and begin executing M1 task-by-task using subagent-driven-development. Continue on branch `feat/mvp-m0-foundations`.

---

## Mission

Build **M1 (Config + Tenancy)**: Table Storage–backed model/pricing registry, principal→project mapping, budget policy resolution, L1 cache + version-bust, and `tenant-context` middleware replacing M0's static seed allowlist. Deny-by-default; fail-closed on missing budget policy.

**Phase A reorg is complete.** Legacy Bun app lives under `legacy/` (read-only). M0 is green (28 gateway tests, compose e2e passes).

## Read first

1. `docs/superpowers/plans/2026-06-09-mvp-m1-config-tenancy.md` — **the plan to execute**
2. `docs/adr/0011-azure-table-storage-config-policy-store-mvp.md`
3. `docs/adr/0013-single-scope-usd-budget-redis-cluster-mvp.md` (policy fail-closed; enforcement is M2)
4. M0 interfaces: `packages/shared/src/contracts/claims.ts`, `services/gateway/src/pipeline/auth.ts`

## Locked decisions

- **Config authority:** Table Storage (ADR-0011); compose/dev uses in-memory store with same entity shapes
- **Budget enforcement:** M2 (Redis Lua); M1 only **resolves** policy and **denies** when missing
- **Legacy reference:** `legacy/src/config/deployments.ts` + `pricing.json` inform seed only — no lift-and-shift
- **Branch:** `feat/mvp-m0-foundations`

## Execution

- subagent-driven-development: one subagent per task, verify before commit
- TDD: failing test → implement → pass → commit
