# Codex Review Fixes: Production Quality Remediation

## TL;DR

> **Quick Summary**: Fix all 7 highest-priority issues from codex review (7.2/10) to bring the LLM Gateway to production quality. Issues span usage mapping bugs, quota tracking gaps, fallback routing, schema alignment, CI correctness, logging, and API documentation.
> 
> **Deliverables**:
> - Fixed Anthropic non-streaming usage mapping with regression test
> - Working soft quota usage tracking (over-budget requests actually charged)
> - Correct fallback model rewriting for all protocols (Anthropic, OpenAI, Responses)
> - Resolved audit/archive FK constraint failures for non-UUID PAT subjects
> - Working CI/canary workflows with correct migration paths and valid PATs
> - Corrected pino logger call order (16 instances across 5 files)
> - Responses API marked as beta/partial with compatibility header
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 5 (soft quota) → Task 5 integration test → F1-F4

---

## Context

### Original Request
Fix all highest-priority issues from codex review scoring 7.2/10. Review identified production-path bugs in: Anthropic non-streaming usage, soft quota accounting, fallback model routing, audit schema alignment, CI workflows, pino logging, and Responses API completeness.

### Interview Summary
**Key Discussions**:
- This was a direct "fix the review" request with clear, well-documented issues
- No design ambiguity — the review provides exact root causes and recommended fixes
- Scope is bugfixes only, no new features

**Research Findings**:
- **Issue 1 (Anthropic usage)**: `proxyNonStreamingAnthropic()` passes raw Anthropic fields (`input_tokens/output_tokens`) without mapping to `prompt_tokens/completion_tokens`. Streaming path correctly maps via `extractUsageFromAnthropicEvents()`. Additional impact: `addLLMSpanAttributes()` produces `NaN` in `totalTokens` corrupting OTEL spans.
- **Issue 2 (Soft quota)**: `reservationId=''` causes all proxy handlers to skip reconciliation (`if (usage && reservationId)` — empty string is falsy). Zero cost tracking, zero metrics, zero audit. The `else if (reservationId)` branch non-execution is actually correct (no reservation to release), but zero accounting is the bug.
- **Issue 3 (Fallback model)**: `createRequestHandler()` switches deployment but never rewrites `body.model`. Anthropic route has NO `transformBody` at all. OpenAI Chat `buildRequestBody()` has a latent bug — it re-looks up `body.model` alias instead of using `activeDeployment.azureModelName`.
- **Issue 4 (Audit schema)**: FK constraint `user_id UUID REFERENCES users(id)` fails for non-UUID PAT subjects. `logRequestAudit()` is fire-and-forget with `.catch()` — silent failures. Migration 002 added `pat_subject` column that enables resolution.
- **Issue 5 (CI/canary)**: `contract.yml` references nonexistent `src/db/migration.sql`. Canary test uses unsigned PAT `lg_test123_test.signature` — auth fails before model validation.
- **Issue 6 (Pino)**: 16 instances across 5 files use `(msg, {obj})` instead of `({obj}, 'msg')`. Context data silently dropped from structured logs.
- **Issue 7 (Responses API)**: Thin wrapper around Chat Completions with intentional limitations. Missing: `previous_response_id`, `instructions`, `metadata`, `tool_choice`, structured output, multimodal. Currently no beta/partial indicator.

### Metis Review
**Identified Gaps** (addressed):
- **OTEL span corruption**: Issue 1 also corrupts OpenTelemetry traces (NaN in totalTokens), not just quota — added to acceptance criteria
- **Foundry latent bug**: Issue 3's `buildRequestBody()` re-looks up `body.model` alias which fails during fallback — must fix for Foundry models too
- **Silent DB failure**: Issue 4's `.catch()` makes FK violations invisible — must surface or at minimum log at error level
- **Canary test validity**: Issue 5's canary test doesn't test what it thinks — auth fails before model validation
- **Test strategy**: Tests-after approach for all bugfixes since these are regressions in existing code — add targeted tests for each fix without going full TDD

---

## Work Objectives

### Core Objective
Fix all 7 highest-priority production-path bugs identified by codex review to bring the gateway to production quality.

### Concrete Deliverables
- `src/proxy/anthropic.proxy.ts` — corrected non-streaming usage mapping
- `src/services/quota.service.ts` + all 3 proxies — soft quota usage tracking
- `src/routes/factories/request-handler.factory.ts` + route files — fallback model rewriting
- `src/db/data-access.ts` + `src/middleware/auth.ts` — PAT subject → UUID resolution
- `.github/workflows/contract.yml` + `.github/workflows/canary.yml` — correct paths and valid PATs
- 5 service/db files — corrected pino call order
- `src/routes/responses.routes.ts` + docs — beta/partial marking

### Definition of Done
- [ ] `bun test` passes with all new regression tests
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] Anthropic non-streaming quota reconciles with correct field names
- [ ] Soft-limit over-budget requests track actual usage and cost
- [ ] Fallback deployment rewrites body.model for all protocols
- [ ] Audit inserts succeed for non-UUID PAT subjects
- [ ] CI migrations reference correct file paths
- [ ] Canary tests use properly signed PATs
- [ ] All pino calls use correct `(mergeObj, msg)` order
- [ ] Responses API returns `X-Gateway-Compatibility: partial` header

### Must Have
- All 7 review issues fixed with regression tests
- No regressions in existing 549 tests
- Correct Anthropic usage field mapping (both streaming and non-streaming)
- Soft quota over-budget requests track usage cost in Redis
- Fallback deployment rewrites body.model for Anthropic route (critical for Azure AI Foundry)
- Audit/archive inserts succeed for non-UUID PAT subjects (via resolution, not schema change)
- CI workflows actually run and test what they claim to test

### Must NOT Have (Guardrails)
- NO schema migration changes (migration 002 already added `pat_subject` column — use it)
- NO new API endpoints or features beyond the 7 fixes
- NO changes to Redis key structure or Lua scripts (soft quota fix uses existing Redis ops)
- NO changes to circuit breaker behavior beyond model rewriting
- NO removing the soft-limit request-allowance behavior (requests must still go through, just with tracking)
- NO expanding Responses API to cover missing features (just mark as beta)
- NO AI slop: no over-abstracting, no excessive comments, no generic variable names

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (bun test, vitest)
- **Automated tests**: Tests-after (targeted regression tests for each bugfix)
- **Framework**: bun test (existing project standard)
- **Approach**: Add specific regression tests for each fix, run alongside existing 549 tests

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Backend**: Use Bash (curl) — Send requests, assert status + response fields
- **Unit tests**: Use Bash (bun test) — Run specific test files, assert pass/fail
- **CI**: Use Bash — Run workflow commands locally, assert output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — all independent bugfixes):
├── Task 1: Fix Anthropic non-streaming usage mapping [unspecified-high]
├── Task 2: Fix pino logger call order [quick]
├── Task 3: Fix CI/canary workflow issues [quick]
└── Task 4: Mark Responses API as beta [quick]

Wave 2 (Start Immediately — more complex, also independent):
├── Task 5: Fix soft quota usage tracking [deep]
├── Task 6: Fix fallback model rewriting [deep]
└── Task 7: Fix audit/archive schema vs PAT subject [deep]

Wave FINAL (After ALL tasks — 4 parallel reviews):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay

Critical Path: Task 5 → F3 (soft quota QA) → F1-F4 → user okay
Parallel Speedup: All 7 tasks run simultaneously
Max Concurrent: 7 (Waves 1+2 combined)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 | — | F1, F2, F3 |
| 2 | — | F1, F2 |
| 3 | — | F1 |
| 4 | — | F1 |
| 5 | — | F1, F2, F3 |
| 6 | — | F1, F2, F3 |
| 7 | — | F1, F2 |
| F1 | 1-7 | user ok |
| F2 | 1-7 | user ok |
| F3 | 1-7 | user ok |
| F4 | 1-7 | user ok |

### Agent Dispatch Summary

- **Wave 1**: 4 tasks — T1 → `unspecified-high`, T2 → `quick`, T3 → `quick`, T4 → `quick`
- **Wave 2**: 3 tasks — T5 → `deep`, T6 → `deep`, T7 → `deep`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Fix Anthropic non-streaming usage field mapping

  **What to do**:
  - In `src/proxy/anthropic.proxy.ts` function `proxyNonStreamingAnthropic()`, map `input_tokens/output_tokens` to `prompt_tokens/completion_tokens` before passing usage to `reconcileUsage()` and `addLLMSpanAttributes()`
  - Create a `mapAnthropicUsageToTokenUsage()` helper (or reuse/adapt `extractUsageFromAnthropicEvents()` pattern) that converts `{input_tokens, output_tokens, thinking_tokens?}` → `{prompt_tokens, completion_tokens, thinking_tokens?}`
  - Apply the mapping at lines ~136-150 where `responseBody?.usage` is consumed — the mapped `TokenUsage` object should be passed to `reconcileUsage()`, `addLLMSpanAttributes()`, `addLlmTokens()`, `addLlmCost()`, `recordLlmRequestDuration()`, and `logRequestAudit()`
  - This also fixes OTEL span corruption: currently `usage.prompt_tokens + usage.completion_tokens` produces `NaN` because those fields are `undefined`
  - Add a regression test in `tests/unit/proxy/anthropic.proxy.test.ts` that mocks an Anthropic non-streaming response with `input_tokens: 25, output_tokens: 10` and asserts that `reconcileUsage` is called with `{prompt_tokens: 25, completion_tokens: 10}`

  **Must NOT do**:
  - Do NOT modify the streaming path (already correct via `extractUsageFromAnthropicEvents()`)
  - Do NOT change the `TokenUsage` interface — it stays as `prompt_tokens/completion_tokens`
  - Do NOT add an abstraction layer — keep the mapping inline and simple

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Moderate complexity bugfix requiring understanding of Anthropic protocol differences and multiple call sites
  - **Skills**: `['backend-development']`
    - `backend-development`: API/data mapping fix in proxy service layer
  - **Skills Evaluated but Omitted**:
    - `database-expert`: No database changes involved

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4)
  - **Blocks**: F1, F2, F3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/proxy/anthropic.proxy.ts:40-52` — `extractUsageFromAnthropicEvents()` shows the correct mapping pattern: `prompt_tokens: event.usage.input_tokens`
  - `src/proxy/anthropic.proxy.ts:58-166` — `proxyNonStreamingAnthropic()` is the function containing the bug
  - `src/proxy/anthropic.proxy.ts:136-150` — Where usage is consumed (reconcile, span, metrics, audit)
  - `src/services/pricing.service.ts:13-20` — `TokenUsage` interface definition with `prompt_tokens/completion_tokens`

  **API/Type References**:
  - `src/services/pricing.service.ts:220-242` — `calculateCost()` consumes `usage.prompt_tokens` and `usage.completion_tokens`
  - `src/services/quota.service.ts:194-217` — `reconcileUsage()` accepts `TokenUsage` parameter

  **Test References**:
  - `tests/unit/proxy/anthropic.proxy.test.ts:96-145` — Existing non-streaming tests (missing usage mapping test)
  - `tests/unit/proxy/anthropic.proxy.test.ts:97-110` — `extractUsageFromAnthropicEvents` test showing expected mapping

  **WHY Each Reference Matters**:
  - The streaming path's `extractUsageFromAnthropicEvents()` is the canonical mapping pattern to follow
  - `reconcileUsage()` and `calculateCost()` consume `prompt_tokens/completion_tokens` — this is what the mapping must produce
  - The existing test structure shows how to mock Anthropic responses and assert on `reconcileUsage` calls

  **Acceptance Criteria**:

  - [ ] `src/proxy/anthropic.proxy.ts` maps `input_tokens → prompt_tokens` and `output_tokens → completion_tokens` in non-streaming path
  - [ ] `bun test tests/unit/proxy/anthropic.proxy.test.ts` → PASS with new regression test
  - [ ] OTEL spans: `addLLMSpanAttributes` receives `prompt_tokens` and `completion_tokens` as numbers (not undefined)
  - [ ] Non-streaming Anthropic response with `input_tokens: 25, output_tokens: 10` produces `usage.prompt_tokens === 25` and `usage.completion_tokens === 10`

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Anthropic non-streaming response usage maps correctly
    Tool: Bash (bun test)
    Preconditions: All existing tests pass
    Steps:
      1. Run: bun test tests/unit/proxy/anthropic.proxy.test.ts
      2. Verify new test "should map Anthropic non-streaming usage fields to TokenUpport format" passes
      3. Run: bun test tests/unit/proxy/anthropic.proxy.test.ts --reporter=verbose
      4. Verify reconcileUsage is called with {prompt_tokens: <number>, completion_tokens: <number>}
    Expected Result: All Anthropic proxy tests pass, no undefined field values
    Failure Indicators: TypeError on undefined token fields, test assertion failures
    Evidence: .sisyphus/evidence/task-1-anthropic-usage-mapping.txt

  Scenario: Anthropic non-streaming with missing usage (edge case)
    Tool: Bash (bun test)
    Preconditions: Existing tests pass
    Steps:
      1. Run: bun test tests/unit/proxy/anthropic.proxy.test.ts
      2. Verify existing test for "success path without usage" still passes
      3. Verify no TypeError when usage is absent
    Expected Result: Existing tests pass unchanged
    Failure Indicators: TypeError, test regressions
    Evidence: .sisyphus/evidence/task-1-anthropic-missing-usage.txt
  ```

  **Commit**: YES
  - Message: `fix(anthropic): map non-streaming usage fields to TokenUpport format`
  - Files: `src/proxy/anthropic.proxy.ts`, `tests/unit/proxy/anthropic.proxy.test.ts`
  - Pre-commit: `bun test tests/unit/proxy/anthropic.proxy.test.ts`

- [x] 2. Fix pino logger call order (16 instances across 5 files)

  **What to do**:
  - Swap argument order in all 16 logger calls from `logger.error('message', { context })` → `logger.error({ context }, 'message')`
  - Files and specific lines to fix:
    1. `src/db/client.ts:32` — `logger.error('Database query failed', { error })` → `logger.error({ error }, 'Database query failed')`
    2. `src/db/data-access.ts:78` — `logger.error('Failed to load user quota policy', { patSubject, error })` → `logger.error({ patSubject, error }, 'Failed to load user quota policy')`
    3. `src/db/data-access.ts:128` — swap order
    4. `src/db/data-access.ts:165` — swap order
    5. `src/db/data-access.ts:188` — swap order
    6. `src/services/quota.service.ts:99` — swap order
    7. `src/services/quota.service.ts:167` — swap order
    8. `src/services/quota.service.ts:244` — swap order
    9. `src/services/quota.service.ts:367` — swap order
    10. `src/services/scheduler.service.ts:21` — swap order
    11. `src/services/scheduler.service.ts:24` — swap order
    12. `src/services/scheduler.service.ts:70` — swap order
    13. `src/services/scheduler.service.ts:73` — swap order
    14. `src/services/shutdown.service.ts:126` — swap order
    15. `src/services/shutdown.service.ts:144` — swap order
    16. `src/services/shutdown.service.ts:176` — swap order
  - After fix, verify with grep that no string-first logger calls remain in `src/db/` and `src/services/`

  **Must NOT do**:
  - Do NOT change any logger calls that already use correct order (object-first)
  - Do NOT add new log messages or change log levels
  - Do NOT modify the logger configuration or helper functions in `src/observability/logger.ts`

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Mechanical find-and-replace with no design decisions
  - **Skills**: `[]`
    - No specialized skills needed for argument swapping
  - **Skills Evaluated but Omitted**:
    - `backend-development`: Overkill for a mechanical fix

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4)
  - **Blocks**: F1, F2
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/db/redis.ts:27` — CORRECT pattern: `logger.error({ err }, 'Redis client error')`
  - `src/proxy/shared.ts:36` — CORRECT pattern: `logger.warn({ err, requestId, reservationId }, 'Failed to release quota reservation')`
  - `src/observability/logger.ts:137,153,162` — Helper functions showing correct pino API usage

  **WHY Each Reference Matters**:
  - These are the canonical patterns to follow when fixing the incorrect calls
  - The logger.ts helpers demonstrate that pino expects `(mergeObj, message)` order

  **Acceptance Criteria**:

  - [ ] All 16 logger calls in 5 files use correct `(mergeObj, message)` argument order
  - [ ] `grep -rn "logger\.\(info\|warn\|error\|debug\) '" src/db/ src/services/` returns zero results
  - [ ] `bun test` — all existing tests still pass
  - [ ] Structured log output contains context fields (no longer dropped)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: All pino calls use correct argument order
    Tool: Bash (grep)
    Preconditions: All fixes applied
    Steps:
      1. Run: grep -rn "logger\.\(info\|warn\|error\|debug\) '" src/db/ src/services/
      2. Assert zero matches (string-first pattern eliminated)
      3. Run: grep -rn "logger\.\(info\|warn\|error\|debug\) {" src/db/ src/services/
      4. Assert 16+ matches showing object-first pattern
    Expected Result: No string-first logger calls remain
    Failure Indicators: grep returns matches for string-first pattern
    Evidence: .sisyphus/evidence/task-2-pino-call-order.txt

  Scenario: Existing tests still pass after logger fix
    Tool: Bash (bun test)
    Preconditions: All fixes applied
    Steps:
      1. Run: bun test
      2. Verify all 549+ tests pass
    Expected Result: All tests pass, no regressions
    Failure Indicators: Any test failure
    Evidence: .sisyphus/evidence/task-2-pino-tests.txt
  ```

  **Commit**: YES
  - Message: `fix(logging): correct pino call order in db and service files`
  - Files: `src/db/client.ts`, `src/db/data-access.ts`, `src/services/quota.service.ts`, `src/services/scheduler.service.ts`, `src/services/shutdown.service.ts`
  - Pre-commit: `bun test`

- [x] 3. Fix CI/canary workflow issues

  **What to do**:
  - **Fix contract.yml migration path** (line 57): Change `src/db/migration.sql || true` to reference the actual migration files: `migrations/001_initial_schema.sql` and `migrations/002_pat_subject.sql`. Remove the `|| true` that was silencing the failure.
  - **Fix canary.yml invalid-model test** (lines 67-75): Replace the invalid PAT `lg_test123_test.signature` with a properly signed PAT. Use the pattern from `tests/integration/helpers/test-pat.ts`: construct a valid PAT using the gateway's PAT_SECRET. If canary runs against an external gateway, the PAT must be provided as a secret. If it's a local gateway, use the test pattern.
  - **Add PAT_SECRET to contract.yml**: Add `PAT_SECRET` environment variable (matching the test pattern `test-secret-that-is-at-least-32-chars-for-ci-only` or a CI-specific secret).
  - Verify both workflows reference correct file paths and use valid authentication.

  **Must NOT do**:
  - Do NOT remove the database setup step from contract.yml — fix it, don't delete it
  - Do NOT change the canary test's intent (testing invalid model rejection) — just fix the PAT so auth passes and model validation is actually reached
  - Do NOT add new workflow features beyond fixing the identified issues

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Three targeted fixes in CI config files, no design decisions
  - **Skills**: `[]`
    - No specialized skills needed for YAML fixes
  - **Skills Evaluated but Omitted**:
    - `backend-development`: Overkill for CI file fixes

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4)
  - **Blocks**: F1
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `.github/workflows/test.yml:13-17` — Shows correct env var setup including `PAT_SECRET`
  - `tests/integration/helpers/test-pat.ts:14-28` — Shows how to construct a valid test PAT with proper HMAC signature

  **API/Type References**:
  - `migrations/001_initial_schema.sql` — Actual migration file path (not `src/db/migration.sql`)
  - `migrations/002_pat_subject.sql` — Second migration file

  **Test References**:
  - `.github/workflows/canary.yml:67-75` — The invalid-model test that needs PAT fix

  **WHY Each Reference Matters**:
  - test.yml shows the correct pattern for env vars in CI
  - test-pat.ts shows how to properly sign a PAT — the canary must use this pattern
  - The migrations directory contains the actual SQL files that contract.yml must reference

  **Acceptance Criteria**:

  - [ ] `contract.yml` references `migrations/001_initial_schema.sql` (and optionally `002_pat_subject.sql`) — no `|| true`
  - [ ] `canary.yml` invalid-model test uses a properly signed PAT that passes auth middleware
  - [ ] `contract.yml` includes `PAT_SECRET` environment variable
  - [ ] Running `cat .github/workflows/contract.yml | grep migration` outputs the correct path

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Contract workflow references correct migration path
    Tool: Bash
    Preconditions: Fix applied
    Steps:
      1. Run: grep -n "migration" .github/workflows/contract.yml
      2. Verify output contains "migrations/001_initial_schema.sql" (not "src/db/migration.sql")
      3. Verify no "|| true" on the migration line
    Expected Result: Correct migration path referenced, no error suppression
    Failure Indicators: Still references src/db/migration.sql or has || true
    Evidence: .sisyphus/evidence/task-3-contract-migration.txt

  Scenario: Canary test uses valid PAT
    Tool: Bash
    Preconditions: Fix applied
    Steps:
      1. Run: grep -A5 "Invalid Model" .github/workflows/canary.yml
      2. Verify the Authorization header contains a properly formatted PAT (lg_{userId}_{header}.{payload}.{signature})
      3. Verify the PAT is not the invalid format "lg_test123_test.signature"
    Expected Result: Canary uses properly signed PAT format
    Failure Indicators: Still uses invalid PAT format
    Evidence: .sisyphus/evidence/task-3-canary-pat.txt
  ```

  **Commit**: YES
  - Message: `fix(ci): correct migration paths and canary PAT in workflows`
  - Files: `.github/workflows/contract.yml`, `.github/workflows/canary.yml`
  - Pre-commit: `bun test`

- [x] 4. Mark Responses API as beta/partial with compatibility header

  **What to do**:
  - Add `X-Gateway-Compatibility: partial` response header to Responses API routes in `src/routes/responses.routes.ts`
  - Update `docs/api/responses-api.md` to add a clearly visible beta/partial status notice at the top, listing the unsupported features: `previous_response_id`, `instructions`, `metadata`, `store`, configurable `tool_choice`, structured output, multimodal, audio, `top_p`/`presence_penalty`/`frequency_penalty`
  - In the route handler, add the header after successful processing: `c.header('X-Gateway-Compatibility', 'partial')`
  - Add a brief comment in the route file explaining the header's purpose

  **Must NOT do**:
  - Do NOT implement any missing Responses API features — this is documentation + header only
  - Do NOT change the route's schema validation (keep existing supported fields)
  - Do NOT add the header to other routes (only Responses API)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small code change (1 header) + docs update
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `backend-development`: Overkill for a header + docs change

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3)
  - **Blocks**: F1
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/routes/responses.routes.ts:74-79` — Current middleware chain to add header after
  - `src/routes/chat.routes.ts` — Example of route without compatibility header (don't add it here)
  - `docs/api/responses-api.md` — Current documentation to update

  **API/Type References**:
  - `src/proxy/openai-responses.proxy.ts:35-40` — Static hardcoded fields showing current limitations

  **WHY Each Reference Matters**:
  - The route handler is where the header must be added
  - The existing docs file is where the beta notice goes
  - The proxy's hardcoded fields show what's known to be limited

  **Acceptance Criteria**:

  - [ ] `docs/api/responses-api.md` has a clear beta/partial notice at the top listing unsupported features
  - [ ] `src/routes/responses.routes.ts` adds `X-Gateway-Compatibility: partial` header to successful responses
  - [ ] `bun test` — all existing tests still pass
  - [ ] Other routes (`/v1/chat/completions`, `/v1/messages`) do NOT have this header

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Responses API returns compatibility header
    Tool: Bash (curl)
    Preconditions: Gateway running locally
    Steps:
      1. Send a valid Responses API request: curl -s -D- http://localhost:3000/v1/responses -H "Authorization: Bearer <valid-pat>" -H "Content-Type: application/json" -d '{"model":"gpt-4o","input":"hello"}'
      2. Check response headers for X-Gateway-Compatibility: partial
    Expected Result: Response includes X-Gateway-Compatibility: partial header
    Failure Indicators: Header missing or set to different value
    Evidence: .sisyphus/evidence/task-4-responses-header.txt

  Scenario: Other routes do NOT return compatibility header
    Tool: Bash (grep)
    Preconditions: Fix applied
    Steps:
      1. Run: grep -rn "X-Gateway-Compatibility" src/routes/
      2. Verify only responses.routes.ts contains this header
    Expected Result: Only responses route has the compatibility header
    Failure Indicators: Chat or messages routes also have the header
    Evidence: .sisyphus/evidence/task-4-no-other-headers.txt
  ```

  **Commit**: YES
  - Message: `feat(responses): mark responses API as beta with compatibility header`
  - Files: `src/routes/responses.routes.ts`, `docs/api/responses-api.md`
  - Pre-commit: `bun test`

- [x] 5. Fix soft quota usage tracking for over-budget requests

  **What to do**:
  - In `src/services/quota.service.ts`, add a new `recordUsageOnly(userId: string, actualUsage: TokenUsage, model: string): Promise<Decimal>` function that:
    - Calculates cost from `actualUsage` using existing `calculateCost()`
    - Directly increments `quota:{userId}:{month}` hash `spent` field by the actual cost
    - Does NOT create or modify reservations
    - Returns the calculated cost
  - In `src/middleware/quota.ts`, change the soft-limit over-budget path (lines 130-152):
    - Instead of setting `reservationId` to empty string, set a context variable `softQuotaMode: true` (or similar) so downstream proxies know to use `recordUsageOnly` instead of `reconcileUsage`
    - Also store the `userId` in context (already available) so `recordUsageOnly` can be called
    - Keep the `releaseQuota` as a no-op (correct behavior — no reservation to release)
  - In all 3 proxy handlers (`openai-chat.proxy.ts`, `anthropic.proxy.ts`, `openai-responses.proxy.ts`), add a branch for soft-quota mode:
    - When `softQuotaMode` is true AND usage is present: call `recordUsageOnly(userId, usage, model)` instead of `reconcileUsage(reservationId, usage, model)`
    - Still record tokens, cost, and audit metrics (these were previously skipped)
    - Ensure `addLLMSpanAttributes`, `addLlmTokens`, `addLlmCost`, `recordLlmRequestDuration`, `logRequestAudit` are still called
  - Add focused tests for the new `recordUsageOnly` function and the soft-quota path integration

  **Must NOT do**:
  - Do NOT change the reservation flow for hard-limit (over-budget with hard_limit=true returns 429, correct behavior)
  - Do NOT modify existing `reconcileUsage` or `checkAndReserve` functions — add new function alongside
  - Do NOT change Redis Lua scripts — `recordUsageOnly` uses standard Redis commands (HINCRBYFLOAT)
  - Do NOT remove the soft-limit request-allowance — requests must still go through, just with tracking
  - Do NOT create "soft reservations" — this adds complexity; direct spend tracking is simpler and correct

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Multi-file change spanning middleware + 3 proxies + service layer, requires understanding of quota flow and careful testing
  - **Skills**: `['backend-development']`
    - `backend-development`: Designing the recordUsageOnly function and integrating across middleware/proxy layers
  - **Skills Evaluated but Omitted**:
    - `database-expert`: Redis operations are simple HINCRBYFLOAT, no schema design needed

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7)
  - **Blocks**: F1, F2, F3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/services/quota.service.ts:194-217` — `reconcileUsage()` — the function to model `recordUsageOnly` after (simpler version without reservation logic)
  - `src/services/quota.service.ts:118-135` — `releaseReservation()` — shows Redis key patterns for quota operations
  - `src/services/quota.service.ts:60-90` — Quota key patterns (`quota:{userId}:{YYYY-MM}`)

  **API/Type References**:
  - `src/middleware/quota.ts:130-152` — Soft-limit over-budget path that currently sets `reservationId=''`
  - `src/proxy/openai-chat.proxy.ts:153-170` — Non-streaming usage reconciliation (pattern to add soft-quota branch to)
  - `src/proxy/anthropic.proxy.ts:136-150` — Anthropic non-streaming reconciliation (Task 1 fixes field mapping here)
  - `src/proxy/openai-responses.proxy.ts:50-72` — Responses non-streaming (wraps chat proxy)

  **Test References**:
  - `tests/unit/middleware/quota.test.ts:103-200` — Existing soft-limit tests (need to extend with usage tracking verification)
  - `tests/unit/services/quota.service.test.ts` — Existing quota service unit tests

  **WHY Each Reference Matters**:
  - `reconcileUsage()` is the model for `recordUsageOnly()` — same cost calculation, different storage path
  - The middleware's soft-limit path is where the bug originates — context variable must be set here
  - All 3 proxy handlers need the soft-quota branch — they're where reconciliation was previously skipped
  - Existing soft-limit tests must be extended, not replaced

  **Acceptance Criteria**:

  - [ ] New `recordUsageOnly(userId, usage, model)` function in `src/services/quota.service.ts` increments `spent` directly
  - [ ] Soft-limit path in `src/middleware/quota.ts` sets a context variable indicating soft-quota mode (not `reservationId=''`)
  - [ ] All 3 proxy handlers call `recordUsageOnly` when in soft-quota mode (instead of skipping reconciliation)
  - [ ] Tokens, cost, duration metrics, and audit logs are recorded for soft-quota requests
  - [ ] `bun test` — all existing + new tests pass
  - [ ] Hard-limit path (429 response) unchanged — still blocks the request

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Soft-limit over-budget request tracks usage cost
    Tool: Bash (bun test)
    Preconditions: Soft-limit enabled (QUOTA_SOFT_LIMIT_ENABLED=true, user with hard_limit=false)
    Steps:
      1. Run: bun test tests/unit/middleware/quota.test.ts
      2. Verify new test: "soft-limit over-budget request records usage cost via recordUsageOnly"
      3. Run: bun test tests/unit/services/quota.service.test.ts
      4. Verify new test: "recordUsageOnly increments spent without reservation"
    Expected Result: Soft-limit requests have cost tracked in Redis via direct HINCRBYFLOAT
    Failure Indicators: Test failure, or reconcileUsage called instead of recordUsageOnly
    Evidence: .sisyphus/evidence/task-5-soft-quota-tracking.txt

  Scenario: Hard-limit over-budget still returns 429 (no regression)
    Tool: Bash (bun test)
    Preconditions: Hard-limit enabled (user with hard_limit=true)
    Steps:
      1. Run: bun test tests/unit/middleware/quota.test.ts
      2. Verify existing hard-limit test: "hard limit returns 429 when over budget"
    Expected Result: Hard-limit unchanged — 429 response, no usage tracking (request blocked)
    Failure Indicators: Hard-limit test fails, or soft-limit code runs for hard-limit
    Evidence: .sisyphus/evidence/task-5-hard-limit-unchanged.txt

  Scenario: Audit log recorded for soft-quota request
    Tool: Bash (bun test)
    Preconditions: Soft-limit path active
    Steps:
      1. Run: bun test tests/unit/proxy/openai-chat.proxy.test.ts
      2. Verify new test: "soft-quota mode calls logRequestAudit with usage data"
    Expected Result: logRequestAudit is called even when reservationId is empty
    Failure Indicators: logRequestAudit not called, or missing cost data
    Evidence: .sisyphus/evidence/task-5-soft-quota-audit.txt
  ```

  **Commit**: YES
  - Message: `fix(quota): track usage for soft-limit over-budget requests`
  - Files: `src/services/quota.service.ts`, `src/middleware/quota.ts`, `src/proxy/openai-chat.proxy.ts`, `src/proxy/anthropic.proxy.ts`, `src/proxy/openai-responses.proxy.ts`, `tests/unit/middleware/quota.test.ts`, `tests/unit/services/quota.service.test.ts`
  - Pre-commit: `bun test`

- [x] 6. Fix fallback model rewriting for all protocols

  **What to do**:
  - In `src/routes/factories/request-handler.factory.ts`, after fallback deployment selection (when `activeDeployment !== deployment.value`), rewrite `bodyRecord.model` to `activeDeployment.azureModelName`. This is the central fix point.
  - Specifically: after the circuit breaker fallback loop (lines 100-113), if `activeDeployment !== deployment.value`, mutate `bodyRecord.model = activeDeployment.azureModelName`
  - For the Anthropic messages route (`src/routes/messages.routes.ts`), this is the ONLY needed change — currently it has NO `transformBody`, so body.model was never rewritten
  - For the OpenAI Chat route, fix `buildRequestBody()` in `src/proxy/openai-chat.proxy.ts` (lines 55-56): change `getDeploymentByAlias(body.model as string)?.azureModelName || body.model` to use the deployment's `azureModelName` directly when a fallback was detected (or simplify since the body.model is now pre-rewritten)
  - For the OpenAI Responses route, it wraps Chat Completions, so fixing the factory and Chat proxy covers it
  - Add a `transformBody` function to the Anthropic route handler that ensures `body.model = deployment.azureModelName` (belt-and-suspenders approach)
  - Add integration tests verifying fallback model rewriting for Anthropic and OpenAI protocols

  **Must NOT do**:
  - Do NOT change the circuit breaker logic or fallback chain ordering
  - Do NOT add new deployments or modify deployment configurations
  - Do NOT change how fallback deployment selection works (keep `getFallbackChain`)
  - Do NOT rewrite body.model when NOT using a fallback (primary deployment should use the original model)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Multi-file change affecting request handling across all protocols, requires understanding of fallback and deployment model interaction
  - **Skills**: `['backend-development']`
    - `backend-development`: API request handling and proxy routing design
  - **Skills Evaluated but Omitted**:
    - `database-expert`: No database changes involved

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 7)
  - **Blocks**: F1, F2, F3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/routes/factories/request-handler.factory.ts:85-165` — `createRequestHandler()` — fallback selection happens here (lines 97-113)
  - `src/config/deployments.ts:72-156` — Deployment definitions with `fallbackDeployment` chains and `azureModelName` fields
  - `src/proxy/openai-chat.proxy.ts:49-63` — `buildRequestBody()` — current partial model rewriting for Foundry models

  **API/Type References**:
  - `src/routes/messages.routes.ts:81` — Anthropic route currently has NO transformBody
  - `src/proxy/anthropic.proxy.ts:18-22` — `buildUpstreamUrlAnthropic()` — no deployment name in URL, model comes from body
  - `src/config/deployments.ts:190-204` — `getFallbackChain()` function

  **Test References**:
  - `tests/unit/routes/` — Unit test directory for route handlers
  - `tests/integration/routes/` — Integration test directory

  **WHY Each Reference Matters**:
  - The factory is the central point where fallback selection and model rewriting should happen — one fix propagates to all protocols
  - Anthropic route's lack of `transformBody` is the critical gap — body.model controls upstream model at Foundry
  - The Foundry `buildRequestBody` has a latent bug — it re-looks up `body.model` instead of using the deployment's `azureModelName`

  **Acceptance Criteria**:

  - [ ] `createRequestHandler()` rewrites `bodyRecord.model` to `activeDeployment.azureModelName` when on fallback
  - [ ] Anthropic messages route has `transformBody` that ensures `body.model = deployment.azureModelName`
  - [ ] OpenAI Chat `buildRequestBody()` uses deployment name directly for Foundry models (not alias lookup on original model)
  - [ ] New test: fallback selection maps to correct model in request body
  - [ ] `bun test` — all tests pass

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Anthropic fallback rewrites body.model
    Tool: Bash (bun test)
    Preconditions: Circuit breaker open for primary deployment
    Steps:
      1. Create test where primary claude-opus-4-6 circuit is open
      2. Send request with model: "claude-opus-4-6"
      3. Verify fallback selects claude-sonnet-4-6
      4. Verify request body sent upstream has model: "claude-sonnet-4-6" (not "claude-opus-4-6")
    Expected Result: Fallback deployment's azureModelName appears in the request body
    Failure Indicators: Original model name still in body upstream
    Evidence: .sisyphus/evidence/task-6-anthropic-fallback.txt

  Scenario: OpenAI Chat Foundry fallback uses correct deployment
    Tool: Bash (bun test)
    Preconditions: Circuit breaker open for primary Foundry deployment
    Steps:
      1. Create test where primary Foundry model circuit is open
      2. Send request for primary model
      3. Verify fallback selection and body.model rewrite
    Expected Result: Request body contains fallback's azureModelName
    Failure Indicators: body.model unchanged after fallback
    Evidence: .sisyphus/evidence/task-6-foundry-fallback.txt

  Scenario: Primary deployment does NOT rewrite model
    Tool: Bash (bun test)
    Preconditions: Primary deployment circuit is closed (normal operation)
    Steps:
      1. Send request with model: "gpt-4o"
      2. Verify body.model is NOT rewritten (stays as the alias or resolved name)
    Expected Result: No model rewriting when not on fallback
    Failure Indicators: Model rewritten even on primary path
    Evidence: .sisyphus/evidence/task-6-primary-no-rewrite.txt
  ```

  **Commit**: YES
  - Message: `fix(proxy): rewrite body.model on fallback deployment selection`
  - Files: `src/routes/factories/request-handler.factory.ts`, `src/routes/messages.routes.ts`, `src/proxy/openai-chat.proxy.ts`
  - Pre-commit: `bun test`

- [x] 7. Fix audit/archive schema alignment with PAT subject model

  **What to do**:
  - In `src/db/data-access.ts`, create a `resolveUserId(userId: string): Promise<string | null>` function that:
    - If `userId` is a valid UUID, return it as-is
    - If `userId` is a non-UUID string (PAT subject), look up `users.pat_subject` in PostgreSQL and return the UUID `id`
    - If no match found, return `null` (and the caller should handle gracefully)
  - In `src/db/data-access.ts`, wrap `logRequestAudit`, `archiveMonthlyUsage`, and `logPatRevocation` to call `resolveUserId()` before inserts
    - If resolution fails, log an error (at `error` level — not `warn` as was done before, since this indicates a data integrity issue) and continue (don't crash the request)
  - In `src/middleware/auth.ts`, consider adding a context variable `resolvedUserId` after PAT authentication that caches the resolution (to avoid per-request DB lookups in the happy path where userId is already a UUID)
  - Add a simple cache or memoization for `resolveUserId` to avoid N+1 queries on repeated users
  - Add tests for `resolveUserId` with both UUID and non-UUID PAT subjects
  - Escalate `logRequestAudit` catch handler from `logger.warn` to `logger.error` (also addresses Issue 6 / pino fix)

  **Must NOT do**:
  - Do NOT change the `users` table schema or FK constraints — keep UUID FK
  - Do NOT remove the `pat_subject` column (migration 002 already added it)
  - Do NOT change PAT token format — it's fine for userId to be a non-UUID string in the token
  - Do NOT make `resolveUserId` blocking — if the DB lookup fails, the request should still succeed (just without audit logging)
  - Do NOT add a new migration file — use the existing `pat_subject` column

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Cross-cutting change spanning auth middleware, data-access layer, and requiring careful error handling for production safety
  - **Skills**: `['backend-development', 'database-expert']`
    - `backend-development`: API auth flow and request lifecycle
    - `database-expert`: Query resolution pattern for PAT subject → UUID lookup
  - **Skills Evaluated but Omitted**:
    - `find-docs`: Not looking up external libraries

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6)
  - **Blocks**: F1, F2
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `src/db/data-access.ts:57-77` — `getUserQuotaPolicyByPatSubject()` — existing pattern for looking up by `pat_subject` column
  - `src/db/data-access.ts:90-118` — `logRequestAudit()` — function to modify (add resolveUserId before insert)
  - `src/db/data-access.ts:138-170` — `archiveMonthlyUsage()` — function to modify

  **API/Type References**:
  - `src/middleware/auth.ts:171` — Where `userId` is set from PAT token
  - `migrations/002_pat_subject.sql` — Migration that added `pat_subject` column
  - `migrations/001_initial_schema.sql:62-80` — `request_audit` table with `user_id UUID REFERENCES users(id)` FK

  **Test References**:
  - `tests/integration/db/data-access.test.ts` — Integration tests using UUID-format userIds only (need to add non-UUID tests)

  **WHY Each Reference Matters**:
  - `getUserQuotaPolicyByPatSubject()` is the existing pattern for `pat_subject` → UUID resolution — `resolveUserId()` should follow this pattern
  - The three insert functions need `resolveUserId()` called before the SQL insert to prevent FK violations
  - Auth middleware is where the PAT userId is extracted — it could cache the resolution
  - Existing tests only use UUID userIds, so non-UUID PAT subjects are never tested

  **Acceptance Criteria**:

  - [ ] `resolveUserId()` function in `src/db/data-access.ts` resolves non-UUID PAT subjects to UUID via `pat_subject` column
  - [ ] `resolveUserId()` returns UUID as-is when already a valid UUID (no DB lookup needed)
  - [ ] `logRequestAudit`, `archiveMonthlyUsage`, `logPatRevocation` all call `resolveUserId()` before inserts
  - [ ] Failed resolution logs at `error` level (not `warn`) and doesn't crash the request
  - [ ] New tests for `resolveUserId` with UUID, non-UUID, and missing user scenarios
  - [ ] `bun test` — all existing + new tests pass

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Audit insert succeeds for non-UUID PAT subject
    Tool: Bash (bun test)
    Preconditions: User with pat_subject='user1' exists in users table
    Steps:
      1. Run: bun test tests/integration/db/data-access.test.ts
      2. Verify new test: "logRequestAudit resolves pat_subject to UUID"
      3. Verify logRequestAudit completes without FK violation for userId='user1'
    Expected Result: Audit record inserted with correct UUID, no FK violation
    Failure Indicators: FK violation error, silent failure logged
    Evidence: .sisyphus/evidence/task-7-audit-non-uuid.txt

  Scenario: Audit insert succeeds for UUID userId (no regression)
    Tool: Bash (bun test)
    Preconditions: Standard UUID userId
    Steps:
      1. Run: bun test tests/integration/db/data-access.test.ts
      2. Verify existing UUID userId tests still pass
    Expected Result: No regression — UUID users unaffected
    Failure Indicators: Existing UUID test failures
    Evidence: .sisyphus/evidence/task-7-audit-uuid.txt

  Scenario: Failed resolution logs error and continues
    Tool: Bash (bun test)
    Preconditions: userId that doesn't exist in users table
    Steps:
      1. Run: bun test tests/unit/db/data-access.test.ts
      2. Verify new test: "resolveUserId returns null for unknown subject"
      3. Verify logRequestAudit doesn't throw, logs error, continues
    Expected Result: Error logged at error level, no crash, audit record skipped
    Failure Indicators: Uncaught exception, request failure
    Evidence: .sisyphus/evidence/task-7-resolution-failure.txt
  ```

  **Commit**: YES
  - Message: `fix(audit): resolve PAT subject to user UUID before database inserts`
  - Files: `src/db/data-access.ts`, `src/middleware/auth.ts`, `tests/integration/db/data-access.test.ts`
  - Pre-commit: `bun test`

---

> 4 review agents run in PARALLEL ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run typecheck` + `bun run lint` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify pino call order is correct in all 5 files.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration: soft quota → Anthropic non-streaming, fallback → Anthropic route, PAT auth → audit logging. Test edge cases: empty usage, zero-cost requests, concurrent soft-quota requests. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Task 1**: `fix(anthropic): map non-streaming usage fields to TokenUpport format` - src/proxy/anthropic.proxy.ts, tests/unit/proxy/anthropic.proxy.test.ts
- **Task 2**: `fix(logging): correct pino call order in db and service files` - src/db/client.ts, src/db/data-access.ts, src/services/quota.service.ts, src/services/scheduler.service.ts, src/services/shutdown.service.ts
- **Task 3**: `fix(ci): correct migration paths and canary PAT in workflows` - .github/workflows/contract.yml, .github/workflows/canary.yml
- **Task 4**: `feat(responses): mark responses API as beta with compatibility header` - src/routes/responses.routes.ts, docs/api/responses-api.md
- **Task 5**: `fix(quota): track usage for soft-limit over-budget requests` - src/services/quota.service.ts, src/middleware/quota.ts, src/proxy/openai-chat.proxy.ts, src/proxy/anthropic.proxy.ts, src/proxy/openai-responses.proxy.ts
- **Task 6**: `fix(proxy): rewrite body.model on fallback deployment selection` - src/routes/factories/request-handler.factory.ts, src/routes/messages.routes.ts, src/proxy/openai-chat.proxy.ts
- **Task 7**: `fix(audit): resolve PAT subject to user UUID before database inserts` - src/db/data-access.ts, src/middleware/auth.ts, tests/integration/db/data-access.test.ts
- **Task 6**: `fix(proxy): rewrite body.model on fallback deployment selection` - src/routes/factories/request-handler.factory.ts, src/routes/messages.routes.ts, src/proxy/openai-chat.proxy.ts
- **Task 7**: `fix(audit): resolve PAT subject to user UUID before database inserts` - src/db/data-access.ts, src/middleware/auth.ts, tests/integration/db/data-access.test.ts

---

## Success Criteria

### Verification Commands
```bash
bun test                                  # Expected: all tests pass (549+ existing + new regressions)
bun run typecheck                         # Expected: no type errors
bun run lint                              # Expected: no lint errors
bun run build                             # Expected: successful build
grep -r "prompt_tokens.*input_tokens" src/proxy/anthropic.proxy.ts  # Expected: mapping found
grep -rn "logger\.\(info\|warn\|error\|debug\) '" src/db/ src/services/  # Expected: no string-first calls
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Soft-limit over-budget requests have usage tracked in Redis
- [ ] Anthropic non-streaming usage correctly maps to prompt_tokens/completion_tokens
- [ ] Fallback deployment rewrites body.model for all protocols
- [ ] Audit inserts succeed for non-UUID PAT subjects
- [ ] CI workflows run correctly with valid PATs
- [ ] Responses API returns compatibility header