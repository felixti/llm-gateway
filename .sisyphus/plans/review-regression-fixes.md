# Review Regression Fixes

## TL;DR

> **Quick Summary**: Fix 4 code review regressions (3 P1, 1 P2): orphaned quota reservations that leak reserved balance, health probes sending wrong model names for Foundry deployments, readiness stuck at 503 when deployment probes disabled, and broken unit test mocks from a new `data-access` import.
>
> **Deliverables**:
> - Test mocks updated — `bun test tests/unit/` passes as full suite
> - Hash-based reservation secondary index — orphan cleanup works after TTL expiry
> - Health probes use `azureModelName` for Foundry deployments
> - `/ready` returns 200 when deployment probes intentionally disabled
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: Task 1 (test mocks) → Task 2 (quota TDD) → Task 3 (quota impl) → Task 6 (readiness) → Final Verification

---

## Context

### Original Request
Code review identified 4 regressions with quality ratings: reliability 5/10, quota/cost correctness 4/10, test health 4/10. The patch is not correct because unit tests fail and there are quota cleanup and health-check regressions that can affect production availability.

### Interview Summary
**Key Discussions**:
- Priority order: Tests first (foundation) → Quota → Health Probes → Readiness
- Test strategy: TDD (write failing tests first, then implement)
- Quota scope: Fix Gaps 1, 3, 5 (secondary index, null handling, user→reservations index). Skip Gaps 2, 4 (clock skew, double-correction).
- Readiness: Set `deployments: true` when `HEALTH_CHECK_DEPLOYMENTS_ENABLED=false`
- PR strategy: Single PR with all 4 fixes

**Research Findings**:
- Quota: Reservation TTL (300s) = cleanup threshold → Redis expires keys before cleanup can scan them. No secondary index means no way to recover the metadata.
- Health: `buildChatCompletionsHealthBody` uses `deployment.name` (gateway alias) but Foundry deployments need `deployment.azureModelName` in the request body. Proxy already handles this correctly.
- Readiness: `startHealthChecks()` returns early when `HEALTH_CHECK_DEPLOYMENTS_ENABLED=false`, cache stays empty, `Array.from(emptyMap.values()).some(h => h.healthy)` → always false → 503 forever.
- Tests: `auth.ts` line 7 imports `resolveUserId` from `data-access`, but 3 test files' `vi.mock()` only expose their own needed exports (`logRequestAudit` or `getUserQuotaPolicyByPatSubject`), causing "Export named 'resolveUserId' not found" when loaded as a suite.

### Metis Review
**Identified Gaps** (addressed):
- 5 distinct quota gaps identified, not just 1 — scoped to Gaps 1, 3, 5 per user decision
- Hash structure recommended for secondary index over Set or Sorted Set
- `releaseReservation`/`reconcileUsage` null handling must be fixed alongside the index (Gap 3)
- Unbounded hash growth — all release/reconcile paths must HDEL from hash
- Race condition: cleanup vs reconcile on same reservation — cleanup must check key still exists before processing
- MockRedis `scan()` returns empty — orphan cleanup unit tests need scan stub or integration tests
- `azureModelName` defensive fallback needed when undefined for Foundry deployments
- Circuit breaker key must stay as `deployment.name` — do NOT change

---

## Work Objectives

### Core Objective
Restore production safety by fixing 4 regressions: quota leak (reserved balance inflation), health probe misfires (circuit breaker opens on healthy models), readiness stuck at 503 (when probes disabled), and test suite red (mock import breakage).

### Concrete Deliverables
- `tests/unit/proxy/anthropic.proxy.test.ts` — mock updated with `resolveUserId`
- `tests/unit/proxy/openai-chat.proxy.test.ts` — mock updated with `resolveUserId`
- `tests/unit/services/quota.service.test.ts` — mock updated with `resolveUserId`
- `src/services/quota.service.ts` — Hash-based secondary index + null handling + cleanup rewrite
- `src/services/health.service.ts` — `buildChatCompletionsHealthBody` uses `azureModelName` for Foundry
- `src/routes/health.routes.ts` — `/ready` skips deployment check when disabled
- Tests for all 4 fixes (TDD)
- `bun test tests/unit/` passes as full suite

### Definition of Done
- [x] `bun test tests/unit/` → all pass, 0 failures
- [x] Quota orphan cleanup works after TTL expiry (reserved balance correctly decremented)
- [x] Health probes for Foundry deployments send `azureModelName` in model field
- [x] `/ready` returns 200 when `HEALTH_CHECK_DEPLOYMENTS_ENABLED=false`
- [x] Circuit breaker key unchanged (still `deployment.name`)

### Must Have
- All 4 fixes working
- TDD test coverage for each fix
- Full unit suite green
- Quota: Hash-based secondary index + HDEL on release/reconcile + cleanup uses hash instead of SCAN
- Health: FOUNDRY_FAMILIES guard pattern matching proxy's approach
- Readiness: deployments=true when disabled, format unchanged when enabled

### Must NOT Have (Guardrails)
- NO extra Redis round-trips in the `checkAndReserve` hot path (outside the Lua script)
- NO change to circuit breaker key from `deployment.name`
- NO change to `/health` endpoint behavior
- NO change to API contracts or response structures for enabled-case paths
- NO Gap 4 fix (double-correction) — separate concern, out of scope
- NO Gap 2 fix (clock skew) — edge case, not reported
- NO shared mock factory refactor — minimal change to fix the bug
- NO reservation TTL changes (stays 300s default)
- NO extraction of shared model-name-resolution utility — follow existing pattern inline

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (Bun test runner, vi.mock)
- **Automated tests**: TDD — write failing tests first, then implement
- **Framework**: Bun test (built-in)
- **TDD**: Each task follows RED (failing test) → GREEN (minimal impl) → REFACTOR

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Unit tests**: `bun test tests/unit/` — verify pass/fail
- **API/Backend**: Bash (curl) — send requests, assert status + response fields
- **Module logic**: Bash (bun REPL) — import, call functions, compare output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — test mocks restored first):
├── Task 1: Fix data-access mocks in 3 test files [quick]
└── Task 2: Write TDD tests for quota orphan fix [deep]

Wave 2 (Core fixes — max parallel after Wave 1):
├── Task 3: Implement quota hash-based secondary index [deep]
├── Task 4: Write TDD tests + implement health probe fix [quick]
└── Task 5: Write TDD tests + implement readiness fix [quick]

Wave 3 (Integration + cleanup):
├── Task 6: Extend MockRedis `scan()` for orphan cleanup tests [unspecified-high]
└── Task 7: Full suite validation + edge case tests [deep]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay
```

### Dependency Matrix

| Task | Blocked By | Blocks |
|------|-----------|--------|
| 1 | — | 2, 3, 4, 5, 6, 7 |
| 2 | 1 | 3, 6 |
| 3 | 2 | 6, 7 |
| 4 | 1 | 7 |
| 5 | 1 | 7 |
| 6 | 3 | 7 |
| 7 | 3, 4, 5, 6 | F1-F4 |

### Agent Dispatch Summary

- **Wave 1**: 2 tasks — T1 → `quick`, T2 → `deep`
- **Wave 2**: 3 tasks — T3 → `deep`, T4 → `quick`, T5 → `quick`
- **Wave 3**: 2 tasks — T6 → `unspecified-high`, T7 → `deep`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Fix data-access vi.mock() in 3 test files

  **What to do**:
  - Add `resolveUserId: vi.fn()` to the `vi.mock('../../../src/db/data-access', ...)` factory in:
    1. `tests/unit/proxy/anthropic.proxy.test.ts` (lines 23-25)
    2. `tests/unit/proxy/openai-chat.proxy.test.ts` (lines 44-46)
    3. `tests/unit/services/quota.service.test.ts` (lines 16-18)
  - Each mock factory should include ALL named exports that any code path (including transitive imports via auth middleware) might request from `data-access`:
    - `resolveUserId: vi.fn()`
    - `logRequestAudit: (...args: unknown[]) => mockLogRequestAudit(...args)` (for proxy tests) or existing inline
    - `getUserQuotaPolicyByPatSubject: ...` (for quota tests) or existing inline
  - Run `bun test tests/unit/` as a FULL SUITE to confirm no "Export named 'X' not found" errors
  - Run each subdirectory individually as a sanity check

  **Must NOT do**:
  - Do NOT refactor mocks into a shared factory (separate concern)
  - Do NOT change auth.test.ts (already correct)
  - Do NOT add unnecessary mock exports beyond what's needed to prevent module resolution failures

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple, mechanical mock additions to 3 files
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `backend-development`: Not API design work

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 2 conceptually, but T2 depends on T1 passing tests)
  - **Parallel Group**: Wave 1 (with Task 2, but Task 2 blocked by this)
  - **Blocks**: 2, 3, 4, 5, 6, 7
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `tests/unit/middleware/auth.test.ts:15-17` — Correct mock pattern already includes `resolveUserId`
  - `tests/unit/proxy/anthropic.proxy.test.ts:23-25` — Current mock (missing resolveUserId)
  - `tests/unit/proxy/openai-chat.proxy.test.ts:44-46` — Current mock (missing resolveUserId)
  - `tests/unit/services/quota.service.test.ts:16-18` — Current mock (missing resolveUserId)

  **API/Type References**:
  - `src/db/data-access.ts` — Actual exports: `resolveUserId`, `logRequestAudit`, `getUserQuotaPolicyByPatSubject` (and possibly others — check the file)
  - `src/middleware/auth.ts:7` — The import that triggers the failure: `import { resolveUserId } from '@/db/data-access'`

  **WHY Each Reference Matters**:
  - `auth.test.ts:15-17`: Copy the resolveUserId mock pattern from here
  - `data-access.ts`: Check what ALL named exports exist so we can ensure no future import breaks the same way
  - `auth.ts:7`: This is the root cause import that needs resolveUserId in all mocks

  **Acceptance Criteria**:

  - [x] `bun test tests/unit/` → all pass, 0 failures, 0 "Export named" errors
  - [ ] `bun test tests/unit/proxy/` → all pass
  - [ ] `bun test tests/unit/middleware/` → all pass
  - [ ] `bun test tests/unit/services/` → all pass

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Full unit suite passes after mock updates
    Tool: Bash
    Preconditions: All 3 test files updated with resolveUserId mock
    Steps:
      1. Run `bun test tests/unit/`
      2. Check exit code is 0
      3. Check output contains "X pass" and "0 fail"
    Expected Result: Exit code 0, all tests pass, no module resolution errors
    Failure Indicators: Non-zero exit code, "Export named 'resolveUserId' not found" in output
    Evidence: .sisyphus/evidence/task-1-suite-pass.txt

  Scenario: Individual proxy tests still pass independently
    Tool: Bash
    Preconditions: Mocks updated
    Steps:
      1. Run `bun test tests/unit/proxy/`
      2. Check exit code is 0
    Expected Result: All proxy tests pass
    Failure Indicators: Any test failure
    Evidence: .sisyphus/evidence/task-1-proxy-pass.txt
  ```

  **Commit**: YES
  - Message: `fix(tests): add resolveUserId to data-access mocks`
  - Files: `tests/unit/proxy/anthropic.proxy.test.ts`, `tests/unit/proxy/openai-chat.proxy.test.ts`, `tests/unit/services/quota.service.test.ts`
  - Pre-commit: `bun test tests/unit/`

- [x] 2. Write TDD tests for quota orphan reservation fix

  **What to do**:
  - Write FAILING tests that will pass once the hash-based secondary index is implemented in Task 3:
    1. **Orphan detection after TTL expiry**: Create a reservation, simulate TTL key expiry (delete the `reservation:{id}` key), then call `cleanupOrphanedReservations()`. Assert that `reserved:{userId}:{month}` is correctly decremented.
    2. **releaseReservation with expired key**: Create reservation, expire the key, call `releaseReservation()`. Assert reserved balance is still corrected via hash lookup.
    3. **reconcileUsage with expired key**: Create reservation, expire the key, call `reconcileUsage()`. Assert reserved balance is still corrected via hash lookup.
    4. **Hash cleanup on reconcile/release**: Assert that HDEL is called on `reservations_meta:{userId}:{month}` after successful reconcile/release (prevents unbounded growth).
    5. **Cleanup vs reconcile race**: Assert that cleanup checks if the TTL key still exists before processing (prevents double-correction).
    6. **Multiple reservations per user**: Create 2 reservations for same user:month, expire one, cleanup. Assert only the expired one is cleaned, the other's reserved balance is untouched.
  - These tests MUST fail initially (RED phase) since the hash-based index doesn't exist yet
  - Stub MockRedis.hset/hget/hdel/hgetall as needed for test infrastructure
  - Extend MockRedis with a configurable `scan()` mock or use `vi.fn()` stubs to return key lists for cleanup tests
  - Place tests in `tests/unit/services/quota-orphan-cleanup.test.ts` (new file)

  **Must NOT do**:
  - Do NOT implement the fix yet (TDD — tests first)
  - Do NOT test Gap 4 (double-correction) or Gap 2 (clock skew) — out of scope
  - Do NOT modify existing quota tests (add new test file)
  - Do NOT add integration tests with real Redis (unit tests with mocks only)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Requires understanding the reservation lifecycle and designing comprehensive test scenarios
  - **Skills**: [`backend-development`]
    - `backend-development`: Database/service testing patterns
  - **Skills Evaluated but Omitted**:
    - `test-driven-development`: Already following TDD approach by task design

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 1's mocks being in place)
  - **Parallel Group**: Wave 1 (after Task 1)
  - **Blocks**: 3, 6
  - **Blocked By**: 1

  **References**:

  **Pattern References**:
  - `tests/unit/services/quota.service.test.ts` — Existing quota test patterns, MockRedis usage, assertion style
  - `src/services/quota.service.ts:80-98` — CHECK_AND_RESERVE_SCRIPT Lua structure (understand what needs updating)
  - `src/services/quota.service.ts:175-195` — releaseReservation() flow (where hash lookup will be added)
  - `src/services/quota.service.ts:198-224` — reconcileUsage() flow (where hash lookup will be added)
  - `src/services/quota.service.ts:297-360` — cleanupOrphanedReservations() current logic (will be rewritten to use hash)

  **API/Type References**:
  - `src/services/quota.service.ts:105-106` — Reservation data format: `{cost}|{userId}|{month}|{createdAt}`
  - `src/services/quota.service.ts:23` — RESERVATION_TTL_SECONDS = 300 (default)
  - `src/config/env.ts:69` — QUOTA_RESERVATION_TTL_SECONDS env var

  **WHY Each Reference Matters**:
  - `quota.service.test.ts`: Copy the MockRedis setup pattern and assertion style
  - Lua script lines 80-98: Need to understand the existing atomicity guarantee before adding hash writes
  - `releaseReservation`/`reconcileUsage`: These are the functions that need hash lookup when TTL key is null
  - `cleanupOrphanedReservations`: This function will be rewritten from SCAN-based to hash-based

  **Acceptance Criteria**:

  - [ ] New test file `tests/unit/services/quota-orphan-cleanup.test.ts` created
  - [ ] `bun test tests/unit/services/quota-orphan-cleanup.test.ts` → FAILS (RED phase — tests exist, implementation doesn't)
  - [ ] At least 6 test cases covering the scenarios above
  - [ ] Tests use MockRedis/vi.fn() stubs (not real Redis)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: New test file exists and tests fail (TDD RED)
    Tool: Bash
    Preconditions: Task 1 completed (mocks fixed)
    Steps:
      1. Run `bun test tests/unit/services/quota-orphan-cleanup.test.ts`
      2. Check exit code is non-zero (expected: tests fail because implementation doesn't exist)
      3. Check output shows the test names (confirming tests are structured correctly)
    Expected Result: Tests fail with clear error messages about missing hash-based functionality
    Failure Indicators: Tests pass (implies accidental implementation) or no test file found
    Evidence: .sisyphus/evidence/task-2-red-phase.txt

  Scenario: Existing quota tests still pass
    Tool: Bash
    Preconditions: New test file added, no production code changed
    Steps:
      1. Run `bun test tests/unit/services/quota.service.test.ts`
      2. Check exit code is 0
    Expected Result: All existing quota tests still pass
    Failure Indicators: Regression in existing tests
    Evidence: .sisyphus/evidence/task-2-existing-pass.txt
  ```

  **Commit**: YES
  - Message: `test(quota): add TDD tests for orphan reservation cleanup`
  - Files: `tests/unit/services/quota-orphan-cleanup.test.ts`
  - Pre-commit: `bun test tests/unit/services/quota.service.test.ts` (existing tests still pass)

- [x] 3. Implement hash-based reservation secondary index

  **What to do**:
  - **Update CHECK_AND_RESERVE_SCRIPT** (lines 80-98): Add `HSET reservations_meta:{userId}:{month} {reservationId} {cost}|{createdAt}` inside the existing Lua script. Do NOT add new KEYS — use the reservation key's data to derive the hash key within the script (Redis Lua can compute keys). Alternatively, add the hash key as a 4th KEY if dynamic key computation in Lua isn't feasible.
  - **Update checkAndReserve()**: Pass the hash key `reservations_meta:{userId}:{month}` as an additional ARGV (or KEY) to the Lua script.
  - **Update releaseReservation()** (lines 175-195): When `redis.get(reservationKey)` returns null:
    1. Look up the reservation ID in the hash: `redis.hget(reservations_meta:{userId}:{month}, reservationId)`
    2. If found: parse cost, decrement `reserved:{userId}:{month}`, HDEL from hash, log warning + increment metric
    3. If not found in hash either: log warning "unrecoverable reservation" + increment metric (no balance adjustment possible)
    4. On success path (key exists): also HDEL from hash after decrement
  - **Update reconcileUsage()** (lines 198-224): Same null-handling pattern as releaseReservation:
    1. When key is null: look up in hash, compute actual cost, decrement reserved, HDEL from hash
    2. On success path: HDEL from hash after reconciliation
  - **Rewrite cleanupOrphanedReservations()** (lines 297-360): Replace SCAN-based approach:
    1. Iterate all known `reservations_meta:*` hash keys (use SCAN on hash pattern since hashes DON'T expire)
    2. For each hash: iterate fields, parse timestamp from value
    3. If `(now - createdAt) > RESERVATION_TTL_SECONDS * 1000` AND the TTL key `reservation:{id}` no longer exists (EXISTS check):
       - Parse cost from hash value
       - Decrement `reserved:{userId}:{month}` by cost
       - HDEL the reservation ID from the hash
       - Increment orphan_cleanup_total metric
    4. The EXISTS check prevents double-correction if reconcile ran between hash check and cleanup
  - **Add metrics**: `quota_orphan_cleaned_total` counter and `quota_reservation_null_total` counter for observability
  - **Verify** the new test file (from Task 2) now passes (GREEN phase)

  **Must NOT do**:
  - Do NOT add extra Redis round-trips outside the Lua script in `checkAndReserve` hot path
  - Do NOT change the reservation TTL (stays 300s default)
  - Do NOT change QUOTA_MULTIPLIER or any other quota parameters
  - Do NOT fix Gap 4 (double-correction atomic cleanup) — EXISTS check is sufficient but not fully atomic
  - Do NOT fix Gap 2 (timestamp vs TTL clock skew) — edge case
  - Do NOT change the Lua script's KEYS count if it would break existing atomicity guarantees (test carefully)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex multi-function change involving Lua scripts, Redis data model, race conditions, and financial correctness
  - **Skills**: [`backend-development`, `database-expert`]
    - `backend-development`: Service logic, error handling, TDD completion
    - `database-expert`: Redis Lua scripts, hash operations, atomicity patterns
  - **Skills Evaluated but Omitted**:
    - `cavecrew`: Too complex for single-file builder subagent

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 2's test structure)
  - **Parallel Group**: Wave 2 (with Tasks 4, 5)
  - **Blocks**: 6, 7
  - **Blocked By**: 2

  **References**:

  **Pattern References**:
  - `src/services/quota.service.ts:80-98` — CHECK_AND_RESERVE_SCRIPT: existing Lua script pattern to extend with HSET
  - `src/services/quota.service.ts:105-111` — checkAndReserve(): where reservation is created, add hash key derivation
  - `src/services/quota.service.ts:175-195` — releaseReservation(): add hash lookup + HDEL on both paths
  - `src/services/quota.service.ts:198-224` — reconcileUsage(): add hash lookup + HDEL on both paths
  - `src/services/quota.service.ts:297-360` — cleanupOrphanedReservations(): rewrite from SCAN to hash iteration
  - `src/services/quota.service.ts:382-390` — CLEANUP_ORPHAN_SCRIPT: may need updating or replacing

  **API/Type References**:
  - `src/config/env.ts:69` — QUOTA_RESERVATION_TTL_SECONDS default 300
  - `src/observability/metrics.ts` — Metric registration pattern for new counters
  - `src/db/redis.ts` — Redis client, existing helper functions

  **WHY Each Reference Matters**:
  - Lua script (80-98): Must extend with HSET without breaking existing atomicity
  - checkAndReserve (105-111): This is the ONLY place reservations are created — must also write to hash
  - releaseReservation (175-195): Must add null-key fallback via hash lookup (Gap 3 fix)
  - reconcileUsage (198-224): Must add null-key fallback via hash lookup (Gap 3 fix)
  - cleanupOrphanedReservations (297-360): Complete rewrite from SCAN to hash iteration (Gap 1 fix)
  - metrics.ts: Pattern for adding new counters

  **Acceptance Criteria**:

  - [ ] `bun test tests/unit/services/quota-orphan-cleanup.test.ts` → PASS (GREEN phase)
  - [ ] `bun test tests/unit/services/quota.service.test.ts` → PASS (no regression)
  - [ ] Hash key format: `reservations_meta:{userId}:{YYYY-MM}`
  - [ ] Hash value format: `{reservationId}: {cost}|{createdAt}` or similar parseable format
  - [ ] checkAndReserve Lua script includes HSET for the hash
  - [ ] releaseReservation and reconcileUsage HDEL from hash on success
  - [ ] releaseReservation and reconcileUsage fall back to hash lookup on null TTL key
  - [ ] cleanupOrphanedReservations iterates hash keys instead of SCAN on reservation:* pattern
  - [ ] Cleanup includes EXISTS check before processing each reservation (prevents double-correction)
  - [ ] New metrics registered: `quota_orphan_cleaned_total`, `quota_reservation_null_total`

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Orphan cleanup decrements reserved balance after TTL expiry (Gap 1)
    Tool: Bash
    Preconditions: Reservation created with cost=0.05, TTL key manually deleted (simulating expiry)
    Steps:
      1. In test: call checkAndReserve(userId='test-user', cost=0.05, month='2026-05')
      2. Delete the reservation:{id} key (simulate TTL expiry)
      3. Read reserved:{test-user}:2026-05 → should show 0.05 (still inflated)
      4. Call cleanupOrphanedReservations()
      5. Read reserved:{test-user}:2026-05 → should show 0.00 (cleaned)
    Expected Result: Reserved balance correctly decremented from 0.05 to 0.00 after cleanup
    Failure Indicators: Reserved balance still 0.05 after cleanup
    Evidence: .sisyphus/evidence/task-3-orphan-cleanup.txt

  Scenario: releaseReservation works with expired TTL key via hash lookup (Gap 3)
    Tool: Bash
    Preconditions: Reservation created, TTL key deleted
    Steps:
      1. In test: call checkAndReserve(userId='test-user', cost=0.05, month='2026-05')
      2. Delete reservation:{id} key
      3. Call releaseReservation(reservationId)
      4. Read reserved:{test-user}:2026-05 → should show 0.00
    Expected Result: Reserved balance decremented even though TTL key was gone
    Failure Indicators: Reserved balance still inflated (0.05)
    Evidence: .sisyphus/evidence/task-3-release-null-key.txt

  Scenario: Cleanup skips reservations with existing TTL key (race protection)
    Tool: Bash
    Preconditions: Reservation created, TTL key still exists
    Steps:
      1. In test: call checkAndReserve(userId='test-user', cost=0.05, month='2026-05')
      2. Do NOT delete the TTL key
      3. Call cleanupOrphanedReservations()
      4. Read reserved:{test-user}:2026-05 → should still show 0.05 (not cleaned)
    Expected Result: Active reservations not touched by cleanup
    Failure Indicators: Reserved balance incorrectly decremented while reservation is still active
    Evidence: .sisyphus/evidence/task-3-race-protection.txt

  Scenario: Hash entries cleaned up on successful reconcile (unbounded growth prevention)
    Tool: Bash
    Preconditions: Reservation created and reconciled normally
    Steps:
      1. In test: call checkAndReserve(...)
      2. Call reconcileUsage(reservationId, usage, model)
      3. Check hash key: HGET reservations_meta:{userId}:{month} reservationId → should return null
    Expected Result: Hash entry removed after reconciliation
    Failure Indicators: Hash entry still exists (will grow unbounded)
    Evidence: .sisyphus/evidence/task-3-hash-cleanup.txt
  ```

  **Commit**: YES
  - Message: `fix(quota): add hash-based reservation index for orphan cleanup`
  - Files: `src/services/quota.service.ts`, `src/observability/metrics.ts`
  - Pre-commit: `bun test tests/unit/services/`

- [x] 4. Fix health probe model name for Foundry deployments

  **What to do**:
  - **TDD**: First write a failing test in a new or existing test file that asserts `buildChatCompletionsHealthBody(foundryDeployment).model === deployment.azureModelName`
  - **Update `buildChatCompletionsHealthBody()`** in `src/services/health.service.ts` (lines 27-31):
    - Add FOUNDRY_FAMILIES import from `src/config/deployments.ts`
    - Change `model: deployment.name` to:
      ```typescript
      model: FOUNDRY_FAMILIES.includes(deployment.modelFamily)
        ? (deployment.azureModelName || deployment.name)
        : deployment.name,
      ```
    - The `|| deployment.name` fallback handles edge case where `azureModelName` is undefined
  - **Do NOT** change `buildAnthropicHealthBody()` — Claude deployments have `name === azureModelName`
  - **Verify** the circuit breaker key is still `deployment.name` (no change needed)
  - **Test**: Foundry deployment health probe sends `azureModelName`, non-Foundry sends `name`

  **Must NOT do**:
  - Do NOT change circuit breaker key from `deployment.name`
  - Do NOT change URL path construction in health checks (already correct)
  - Do NOT change `buildAnthropicHealthBody()` (not broken for Claude)
  - Do NOT extract a shared model-name-resolution utility (keep inline like the proxy does)
  - Do NOT add retry logic or timeout configuration

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple guard clause addition following existing proxy pattern
  - **Skills**: [`backend-development`]
    - `backend-development`: Service modification, testing
  - **Skills Evaluated but Omitted**:
    - `database-expert`: No database changes

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 3, 5)
  - **Parallel Group**: Wave 2
  - **Blocks**: 7
  - **Blocked By**: 1

  **References**:

  **Pattern References**:
  - `src/proxy/openai-chat.proxy.ts:52-61` — The CORRECT pattern for model name resolution in the proxy. Uses `FOUNDRY_FAMILIES.includes(modelFamily)` + `azureModelName`. Copy this exact approach for health probes.
  - `src/services/health.service.ts:27-31` — Current broken code: `model: deployment.name`
  - `src/services/health.service.ts:123-128` — Where `recordFailure(deployment.name)` is called. Do NOT change this.

  **API/Type References**:
  - `src/config/deployments.ts:63` — `FOUNDRY_FAMILIES: ModelFamily[]` = `['kimi', 'glm', 'minimax']`
  - `src/config/deployments.ts:13-18` — `DeploymentConfig` interface: `name`, `azureModelName`, `modelFamily`
  - `src/config/deployments.ts:111-131` — Example deployment configs showing the name vs azureModelName distinction

  **WHY Each Reference Matters**:
  - `openai-chat.proxy.ts:52-61`: This is the working reference implementation — follow it exactly
  - `health.service.ts:27-31`: The bug location — where the fix goes
  - `deployments.ts:63`: The FOUNDRY_FAMILIES constant to import and use
  - `deployments.ts:111-131`: Test fixture data — understand the name/azureModelName difference for test cases

  **Acceptance Criteria**:

  - [ ] Failing test written first (TDD RED)
  - [ ] `buildChatCompletionsHealthBody(foundryDeployment).model === deployment.azureModelName`
  - [ ] `buildChatCompletionsHealthBody(openaiDeployment).model === deployment.name` (unchanged)
  - [ ] Fallback: when `azureModelName` is undefined, falls back to `deployment.name`
  - [ ] `buildAnthropicHealthBody()` not changed
  - [ ] Circuit breaker key still `deployment.name`
  - [ ] `bun test tests/unit/services/` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Foundry deployment health probe uses azureModelName
    Tool: Bash
    Preconditions: Test with mock Foundry deployment config (name='kimi-k2.5', azureModelName='FW-Kimi-K2.5', modelFamily='kimi')
    Steps:
      1. Call buildChatCompletionsHealthBody(foundryDeployment)
      2. Assert result.model === 'FW-Kimi-K2.5'
    Expected Result: model field contains azureModelName, not gateway alias
    Failure Indicators: model field is 'kimi-k2.5' (gateway alias = still broken)
    Evidence: .sisyphus/evidence/task-4-foundry-model-name.txt

  Scenario: OpenAI deployment health probe unchanged
    Tool: Bash
    Preconditions: Test with mock GPT deployment (name='gpt-4o', azureModelName='gpt-4o', modelFamily='gpt')
    Steps:
      1. Call buildChatCompletionsHealthBody(openaiDeployment)
      2. Assert result.model === 'gpt-4o'
    Expected Result: model field still uses deployment.name (which equals azureModelName for OpenAI)
    Failure Indicators: Different model name or broken field
    Evidence: .sisyphus/evidence/task-4-openai-model-name.txt

  Scenario: Fallback when azureModelName is undefined
    Tool: Bash
    Preconditions: Test with mock deployment where azureModelName=undefined, modelFamily='kimi'
    Steps:
      1. Call buildChatCompletionsHealthBody(deployment)
      2. Assert result.model === deployment.name (fallback)
    Expected Result: Graceful fallback to deployment.name
    Failure Indicators: model is undefined or throws error
    Evidence: .sisyphus/evidence/task-4-fallback.txt
  ```

  **Commit**: YES
  - Message: `fix(health): use azureModelName in Foundry health probes`
  - Files: `src/services/health.service.ts`, test file(s)
  - Pre-commit: `bun test tests/unit/`

- [x] 5. Fix readiness endpoint when deployment probes disabled

  **What to do**:
  - **TDD**: First write a failing test asserting `/ready` returns 200 when `HEALTH_CHECK_DEPLOYMENTS_ENABLED=false`
  - **Update the `/ready` handler** in `src/routes/health.routes.ts` (around line 74):
    - Import `env` from `src/config/env.ts`
    - When `env.HEALTH_CHECK_DEPLOYMENTS_ENABLED === false`:
      - Set `checks.deployments = true` (treat as healthy when intentionally disabled)
      - Do NOT call `getCachedDeploymentHealth()` at all (avoids empty Map)
    - When `env.HEALTH_CHECK_DEPLOYMENTS_ENABLED === true` (default):
      - Current behavior unchanged: `checks.deployments = Array.from(cachedHealth.values()).some((h) => h.healthy)`
  - **Do NOT** change `/health` endpoint behavior
  - **Do NOT** change response format when deployments are enabled (stays `{redis, postgres, deployments}` with booleans)
  - Response body when disabled: `{redis: true, postgres: true, deployments: true}` — consistent format

  **Must NOT do**:
  - Do NOT change `/health` endpoint
  - Do NOT change response format for the enabled case
  - Do NOT add a separate "skipped" sentinel value
  - Do NOT remove the `deployments` key from the response
  - Do NOT change `getCachedDeploymentHealth()` or `startHealthChecks()`

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple conditional check in one route handler
  - **Skills**: [`backend-development`]
    - `backend-development`: Route handler modification, testing
  - **Skills Evaluated but Omitted**:
    - `database-expert`: No database changes

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 3, 4)
  - **Parallel Group**: Wave 2
  - **Blocks**: 7
  - **Blocked By**: 1

  **References**:

  **Pattern References**:
  - `src/routes/health.routes.ts:54-86` — Current `/ready` handler with the deployment check
  - `src/routes/health.routes.ts:74` — The broken line: `checks.deployments = Array.from(cachedHealth.values()).some((h) => h.healthy)`

  **API/Type References**:
  - `src/config/env.ts` — `HEALTH_CHECK_DEPLOYMENTS_ENABLED` env var definition
  - `src/services/health.service.ts:157-161` — `getCachedDeploymentHealth()` returns the empty Map
  - `src/services/health.service.ts:181` — `startHealthChecks()` early return when disabled

  **WHY Each Reference Matters**:
  - `health.routes.ts:54-86`: The exact handler to modify — need to understand full flow
  - `health.routes.ts:74`: The specific line causing 503 when cache is empty
  - `env.ts`: Import the HEALTH_CHECK_DEPLOYMENTS_ENABLED flag
  - `health.service.ts:181`: Confirms that the function exits early (this is WHY the cache is empty)

  **Acceptance Criteria**:

  - [ ] Failing test written first (TDD RED)
  - [ ] `GET /ready` with `HEALTH_CHECK_DEPLOYMENTS_ENABLED=false` → 200, body `{redis: bool, postgres: bool, deployments: true}`
  - [ ] `GET /ready` with `HEALTH_CHECK_DEPLOYMENTS_ENABLED=true` + healthy deployments → 200 (unchanged)
  - [ ] `GET /ready` with `HEALTH_CHECK_DEPLOYMENTS_ENABLED=true` + no healthy deployments → 503 (unchanged)
  - [ ] `GET /health` unaffected
  - [ ] Response format consistent: always includes `redis`, `postgres`, `deployments` keys

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Readiness returns 200 when deployment probes disabled
    Tool: Bash (curl or test client)
    Preconditions: HEALTH_CHECK_DEPLOYMENTS_ENABLED=false, Redis healthy, Postgres healthy
    Steps:
      1. Send GET /ready
      2. Assert status code 200
      3. Assert response body contains "deployments": true
    Expected Result: 200, all checks true including deployments
    Failure Indicators: 503 status or deployments: false
    Evidence: .sisyphus/evidence/task-5-ready-disabled.txt

  Scenario: Readiness returns 503 when deployments enabled and unhealthy
    Tool: Bash (curl or test client)
    Preconditions: HEALTH_CHECK_DEPLOYMENTS_ENABLED=true, no healthy deployments in cache
    Steps:
      1. Send GET /ready
      2. Assert status code 503
      3. Assert response body contains "deployments": false
    Expected Result: 503, deployments check shows false (existing behavior preserved)
    Failure Indicators: 200 when deployments are enabled but unhealthy
    Evidence: .sisyphus/evidence/task-5-ready-unhealthy.txt

  Scenario: Health endpoint unaffected by readiness change
    Tool: Bash (curl or test client)
    Preconditions: Any
    Steps:
      1. Send GET /health
      2. Assert the response format and behavior are unchanged from before this fix
    Expected Result: /health works the same regardless of HEALTH_CHECK_DEPLOYMENTS_ENABLED
    Failure Indicators: /health changes behavior or format
    Evidence: .sisyphus/evidence/task-5-health-unaffected.txt
  ```

  **Commit**: YES
  - Message: `fix(ready): skip deployment check when probes disabled`
  - Files: `src/routes/health.routes.ts`, test file(s)
  - Pre-commit: `bun test tests/unit/`

- [x] 6. Extend MockRedis for orphan cleanup tests

  **What to do**:
  - The unit tests for orphan cleanup (Task 2) need MockRedis to support:
    1. `scan()` returning configurable key lists (instead of always `['0', []]`)
    2. `hset()`, `hget()`, `hdel()`, `hgetall()` — for the hash-based secondary index
    3. `exists()` — for the EXISTS check in cleanup race protection
  - If MockRedis in `tests/` already supports hash operations (check first), only `scan()` and `exists()` may need adding
  - Look for the MockRedis implementation file and extend it
  - Alternative: Use `vi.fn()` stubs in the test file itself rather than extending MockRedis globally (less blast radius)
  - After extending, verify that the TDD tests from Task 2 can properly test happy-path orphan cleanup with the mock returning keys
  - Run `bun test tests/unit/services/quota-orphan-cleanup.test.ts` → should now PASS fully (existing RED tests turn GREEN with Task 3's implementation + these mock extensions)

  **Must NOT do**:
  - Do NOT use real Redis in unit tests
  - Do NOT break existing tests that depend on MockRedis
  - Do NOT add scan() behavior that breaks other test files
  - Do NOT create integration tests here (unit tests only)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Test infrastructure modification requires understanding existing mock patterns and careful implementation
  - **Skills**: [`backend-development`]
    - `backend-development`: Testing patterns, mock design
  - **Skills Evaluated but Omitted**:
    - `database-expert`: No real database work

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 3 implementation)
  - **Parallel Group**: Wave 3 (with Task 7)
  - **Blocks**: 7
  - **Blocked By**: 3

  **References**:

  **Pattern References**:
  - `tests/unit/services/quota.service.test.ts` — Existing MockRedis setup and usage patterns
  - Task 2's test file — `tests/unit/services/quota-orphan-cleanup.test.ts` — What mock capabilities are needed

  **API/Type References**:
  - MockRedis implementation file (find it in `tests/` or `tests/helpers/`)
  - `src/services/quota.service.ts` — Redis commands used: `scan`, `hset`, `hget`, `hdel`, `hgetall`, `exists`, `get`, `set`, `del`, `incrbyfloat`

  **WHY Each Reference Matters**:
  - `quota.service.test.ts`: Understand how existing MockRedis is set up and used
  - `quota-orphan-cleanup.test.ts`: The tests that need these mock extensions
  - Redis commands list: Determine which mock methods are missing vs already implemented

  **Acceptance Criteria**:

  - [ ] MockRedis supports `scan()` with configurable return values
  - [ ] MockRedis supports `hset()`, `hget()`, `hdel()`, `hgetall()`
  - [ ] MockRedis supports `exists()` (if not already)
  - [ ] `bun test tests/unit/services/quota-orphan-cleanup.test.ts` → PASS
  - [ ] `bun test tests/unit/` → all pass (no regression from MockRedis changes)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Orphan cleanup tests pass with MockRedis extensions
    Tool: Bash
    Preconditions: Task 3 implementation done, MockRedis extended
    Steps:
      1. Run `bun test tests/unit/services/quota-orphan-cleanup.test.ts`
      2. Assert all tests pass
    Expected Result: All orphan cleanup tests pass (TDD GREEN)
    Failure Indicators: Any test failure related to scan/hash/exists mock
    Evidence: .sisyphus/evidence/task-6-orphan-tests-green.txt

  Scenario: Existing tests unaffected by MockRedis changes
    Tool: Bash
    Preconditions: MockRedis extended with new methods
    Steps:
      1. Run `bun test tests/unit/`
      2. Assert all tests pass (no regression)
    Expected Result: Full suite green
    Failure Indicators: New test failures caused by MockRedis changes
    Evidence: .sisyphus/evidence/task-6-suite-regression.txt
  ```

  **Commit**: YES
  - Message: `test(quota): extend MockRedis for orphan cleanup tests`
  - Files: MockRedis file, possibly `tests/unit/services/quota-orphan-cleanup.test.ts`
  - Pre-commit: `bun test tests/unit/`

- [x] 7. Full suite validation + edge case tests

  **What to do**:
  - **Full suite validation**: Run `bun test tests/unit/` as complete suite and verify 0 failures
  - **Cross-task integration tests**: Verify fixes work together:
    1. Quota orphan cleanup + health probes: After orphans cleaned, health probe for Foundry still sends correct model name
    2. Readiness + health probes: When deployment probes disabled, readiness skips but health probes (if enabled) still use correct model names
    3. Test mocks + all tests: Ensure mock changes don't interfere with production code behavior
  - **Edge case tests** (add to appropriate test files):
    1. **Month boundary**: Reservation created at end of month (2026-05-31 23:59:59), cleanup runs after midnight. Ensure hash key `reservations_meta:{userId}:2026-05` still matches.
    2. **Multiple users**: Cleanup for user A doesn't affect user B's reservations
    3. **Concurrent cleanup + reconcile**: Verify EXISTS check prevents double-correction
    4. **Empty azureModelName for Foundry**: Health probe falls back to `deployment.name`
    5. **Environment default**: `HEALTH_CHECK_DEPLOYMENTS_ENABLED` unset (defaults to true) → readiness behaves normally
    6. **Module cache pollution**: Run tests in different orders to verify mock consistency
  - **Production smoke test scenarios** (agent-executed, not manual):
    1. Create reservation → simulate stream completion → verify reserved balance reconciled correctly
    2. Create reservation → simulate client abort → verify reserved balance released correctly
    3. Create reservation → simulate TTL expiry → run cleanup → verify balance recovered

  **Must NOT do**:
  - Do NOT add integration tests with real Redis (stay in unit test scope)
  - Do NOT change production code (only test code)
  - Do NOT test Gap 4 (double-correction atomic Lua) — out of scope

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Comprehensive validation across multiple fixes with edge case analysis
  - **Skills**: [`backend-development`]
    - `backend-development`: Testing patterns, integration verification
  - **Skills Evaluated but Omitted**:
    - `verification-before-completion`: Will use this pattern but task is explicitly about verification

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on ALL prior tasks)
  - **Parallel Group**: Wave 3
  - **Blocks**: F1-F4
  - **Blocked By**: 3, 4, 5, 6

  **References**:

  **Pattern References**:
  - `tests/unit/services/quota.service.test.ts` — Existing test patterns
  - `tests/unit/services/quota-orphan-cleanup.test.ts` — Orphan cleanup test file (from Task 2)
  - All test files modified in Tasks 1-5

  **API/Type References**:
  - All production code modified in Tasks 3-5

  **WHY Each Reference Matters**:
  - Existing test patterns: Follow same structure for new edge case tests
  - Orphan cleanup test file: Where to add additional quota edge cases
  - Modified test files: Ensure no cross-contamination from mock changes

  **Acceptance Criteria**:

  - [x] `bun test tests/unit/` → all pass, 0 failures
  - [ ] Edge case tests added for: month boundary, multi-user, concurrent cleanup, empty azureModelName, env default
  - [ ] Cross-task integration verified (quota + health + readiness work together)
  - [ ] No module cache pollution between test files

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Full unit suite passes
    Tool: Bash
    Preconditions: All Tasks 1-6 completed
    Steps:
      1. Run `bun test tests/unit/`
      2. Check exit code is 0
      3. Check output shows N pass, 0 fail, 0 skipped
    Expected Result: Complete green suite
    Failure Indicators: Any test failure
    Evidence: .sisyphus/evidence/task-7-full-suite.txt

  Scenario: Tests pass in reverse order (module cache check)
    Tool: Bash
    Preconditions: All test files exist
    Steps:
      1. Run tests in reverse alphabetical order if possible, or just run the full suite multiple times
      2. Verify consistent results
    Expected Result: Same pass/fail results regardless of test execution order
    Failure Indicators: Different results on different runs
    Evidence: .sisyphus/evidence/task-7-cache-check.txt

  Scenario: Month boundary edge case
    Tool: Bash
    Preconditions: Reservation created with month='2026-05'
    Steps:
      1. Create reservation for user:user1:2026-05
      2. Run cleanup targeting 2026-05
      3. Verify hash key reservations_meta:user1:2026-05 is used correctly
      4. Verify reservations_meta:user1:2026-06 does NOT exist
    Expected Result: Month attribution correct, no cross-month leakage
    Failure Indicators: Wrong month hash key used
    Evidence: .sisyphus/evidence/task-7-month-boundary.txt
  ```

  **Commit**: YES
  - Message: `test: add edge case and integration tests for review fixes`
  - Files: test files
  - Pre-commit: `bun test tests/unit/`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `bun test tests/unit/` + any linter. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task. Test cross-task integration. Test edge cases: empty state, invalid input, rapid actions. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec. Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Task 1**: `fix(tests): add resolveUserId to data-access mocks` — 3 test files
- **Task 2+3**: `fix(quota): add hash-based reservation index for orphan cleanup` — quota.service.ts + tests
- **Task 4**: `fix(health): use azureModelName in Foundry health probes` — health.service.ts + tests
- **Task 5**: `fix(ready): skip deployment check when probes disabled` — health.routes.ts + tests
- **Task 6**: `test(quota): extend MockRedis scan for cleanup tests` — test helpers
- **Task 7**: `test: add edge case and integration tests for review fixes` — test files

---

## Success Criteria

### Verification Commands
```bash
bun test tests/unit/                    # Expected: all pass, 0 failures
bun test tests/unit/middleware/         # Expected: all pass
bun test tests/unit/proxy/              # Expected: all pass
bun test tests/unit/services/           # Expected: all pass
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] All tests pass
- [x] Quota orphan cleanup works after TTL expiry
- [ ] Health probes use azureModelName for Foundry
- [ ] Readiness returns 200 when probes disabled
- [x] Circuit breaker key unchanged