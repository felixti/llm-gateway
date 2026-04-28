# LLM Gateway: From 6/10 to 10/10

**Status:** Draft — Awaiting Approval  
**Classification:** LARGE (multi-phase, full squad, 5 gates)  
**Estimated Effort:** 6-8 hours of focused engineering  
**Target:** Green CI, 100% test pass, 85%+ coverage, production-hardened

---

## Current State (6/10)

| Dimension | Score | Evidence |
|-----------|-------|----------|
| Architecture | 8/10 | Clean middleware chain, factory pattern, Redis Lua atomicity |
| Code Quality | 5/10 | Lint fails, TS fails, dead code, non-idiomatic patterns |
| Tests | 5/10 | 274 unit tests pass, 45 integration tests fail, 76% coverage |
| Security | 6/10 | PAT blocklist good, weak default secrets, no PII sanitization |
| Observability | 7/10 | OTEL + Pino + Prometheus wired, spans incomplete |
| DevOps | 6/10 | Docker good, CI red, 17 uncommitted files |
| Documentation | 7/10 | Architecture docs excellent, no API spec, no squad memory |
| **Overall** | **6/10** | Strong bones, messy execution |

## Target State (10/10)

| Dimension | Target | Definition of Done |
|-----------|--------|-------------------|
| Architecture | 10/10 | No dead code, consistent patterns, idiomatic Hono |
| Code Quality | 10/10 | `bun run ci` passes 100% of the time |
| Tests | 10/10 | 100% pass rate, ≥85% coverage, integration tests self-contained |
| Security | 10/10 | No hardcoded secrets, PII redaction, scope enforcement |
| Observability | 10/10 | Full OTEL spans per PRD, structured logs, alertable metrics |
| DevOps | 10/10 | Clean git history, no uncommitted changes, health checks configurable |
| Documentation | 10/10 | OpenAPI spec, squad memory initialized, runbooks |
| **Overall** | **10/10** | Production-ready with confidence |

---

## Phase Overview

### Phase 1 — Stabilize (Fix What's Broken)
**Goal:** Get `bun run ci` to pass.
- Fix TypeScript errors (integration tests + `postgres` API mismatch)
- Fix biome lint/format issues
- Remove dead code from proxy files
- Commit or clean the 17-file uncommitted diff

### Phase 2 — Harden (Security & Idioms)
**Goal:** Eliminate security gaps and code smell.
- Fix `c.json()` anti-pattern in auth and protocol-guard middleware
- Remove hardcoded `PAT_SECRET` defaults (fail closed in production)
- Add PII redaction to logger
- Add scope validation in auth middleware
- Standardize import style (`@/` aliases everywhere)

### Phase 3 — Test (Coverage & Integration)
**Goal:** 85%+ coverage, all tests pass.
- Rewrite integration tests to use in-memory Hono app (no live server needed)
- Add middleware unit tests (auth, rate-limit, quota, protocol-guard)
- Add proxy tests with mocked `fetch`
- Add db/data-access tests with test Postgres
- Add azure-auth tests with mocked Entra ID token endpoint

### Phase 4 — Observe (Complete Observability)
**Goal:** Match PRD observability spec.
- Add missing OTEL span attributes (per PRD §4.4.1)
- Implement all Prometheus metrics from PRD §4.4.2
- Add `x-ms-client-request-id` propagation
- Implement sampling (100% errors, 10% success)
- Add request/response body logging at DEBUG only

### Phase 5 — Operate (Production Readiness)
**Goal:** Deploy with confidence.
- Make health checks configurable (interval, enable/disable)
- Add dry-run mode for health checks (no Azure calls)
- Fix scheduler `isRunning` race condition
- Add OpenAPI 3.1 spec generation
- Initialize `.context/` squad memory
- Write runbook for common incidents

---

## Detailed Tasks

### Phase 1 — Stabilize

| # | Task | Owner | Files | Gates |
|---|------|-------|-------|-------|
| 1.1 | Fix `postgres` API in integration tests | backend | `tests/integration/db/data-access.test.ts` | 1,2 |
| 1.2 | Run `biome check --write .` and verify | backend | All source | 1 |
| 1.3 | Remove dead Hono apps from proxy files | backend | `src/proxy/*.proxy.ts` | 1,2,4 |
| 1.4 | Commit or revert the 17-file working tree diff | tech-lead | Entire repo | 1 |
| 1.5 | Verify `bun run ci` passes | qa | — | 1,2,3 |

**Acceptance Criteria:**
- `bun run lint` exits 0
- `bun run typecheck` exits 0
- `bun run test` shows 0 failures
- `bun run test:coverage` shows ≥ current coverage (no regressions)
- Git working tree is clean

### Phase 2 — Harden

| # | Task | Owner | Files | Gates |
|---|------|-------|-------|-------|
| 2.1 | Fix `return c.json()` pattern in middleware | backend | `src/middleware/auth.ts`, `src/middleware/protocol-guard.ts` | 1,2,4 |
| 2.2 | Fail closed on missing `PAT_SECRET` in production | backend | `src/config/env.ts` | 1,2,4 |
| 2.3 | Add PII redaction helper and apply to logger | backend | `src/observability/logger.ts` | 1,2,4 |
| 2.4 | Enforce PAT scope in auth middleware | backend | `src/middleware/auth.ts` | 1,2 |
| 2.5 | Standardize imports to `@/` alias | backend | All source | 1,4 |
| 2.6 | Add security-focused unit tests | qa | `tests/unit/security/*.test.ts` | 3 |

**Acceptance Criteria:**
- No `c.json()` without `return` in middleware
- `PAT_SECRET` default only in `development`/`test`, throws in `production`
- Logger redacts `email`, `phone`, `ssn`, `credit_card` patterns
- Scope `read` blocks POST/PUT/DELETE (returns 403)
- All imports use `@/` alias (no `../` except in index.ts barrel files)

### Phase 3 — Test

| # | Task | Owner | Files | Gates |
|---|------|-------|-------|-------|
| 3.1 | Rewrite integration tests with in-memory Hono | backend | `tests/integration/routes/*.test.ts` | 1,2,3 |
| 3.2 | Add middleware unit tests | qa | `tests/unit/middleware/*.test.ts` | 3 |
| 3.3 | Add proxy tests with mocked fetch | qa | `tests/unit/proxy/*.test.ts` | 3 |
| 3.4 | Add db/data-access tests | backend | `tests/integration/db/*.test.ts` | 1,2,3 |
| 3.5 | Add azure-auth tests with mock Entra ID | backend | `tests/unit/services/azure-auth.test.ts` | 3 |
| 3.6 | Verify coverage ≥85% | qa | — | 3 |

**Acceptance Criteria:**
- Integration tests start the Hono app in `beforeAll`, no external services needed
- All 45 previously-failing tests now pass
- Coverage: lines ≥85%, functions ≥80%
- No test flakes (run 3x, same results)

### Phase 4 — Observe

| # | Task | Owner | Files | Gates |
|---|------|-------|-------|-------|
| 4.1 | Add all PRD span attributes to tracing | backend | `src/observability/tracing.ts` | 1,2 |
| 4.2 | Implement missing Prometheus metrics | backend | `src/observability/metrics.ts` | 1,2 |
| 4.3 | Add `x-ms-client-request-id` propagation | backend | `src/proxy/*.proxy.ts` | 1,2 |
| 4.4 | Implement trace sampling (100% errors, 10% success) | backend | `src/observability/tracing.ts` | 1,2 |
| 4.5 | Add DEBUG-level body logging | backend | `src/observability/logger.ts` | 1,2 |
| 4.6 | Add observability contract tests | qa | `tests/integration/observability/*.test.ts` | 3 |

**Acceptance Criteria:**
- Every request creates a span with all PRD attributes
- Metrics endpoint exposes all metrics from PRD §4.4.2
- `x-ms-client-request-id` present on all Azure outbound requests
- Error traces always sampled, success traces 10% sampled
- DEBUG logs include sanitized request/response bodies

### Phase 5 — Operate

| # | Task | Owner | Files | Gates |
|---|------|-------|-------|-------|
| 5.1 | Make health checks configurable | backend | `src/services/health.service.ts`, `src/config/env.ts` | 1,2 |
| 5.2 | Fix scheduler race condition | backend | `src/services/scheduler.service.ts` | 1,2 |
| 5.3 | Generate OpenAPI spec from Zod schemas | backend | `docs/openapi.json` | 1,2 |
| 5.4 | Initialize `.context/` squad memory | tech-lead | `.context/docs/*.md`, `.context/agents/*.md` | — |
| 5.5 | Write incident runbook | tech-lead | `docs/runbook.md` | — |
| 5.6 | Final CI verification | qa | — | 1,2,3,4,5 |

**Acceptance Criteria:**
- `HEALTH_CHECK_ENABLED=true/false` env var works
- `HEALTH_CHECK_INTERVAL_MS` configurable
- Scheduler cleanup and archive jobs have independent `isRunning` flags
- `docs/openapi.json` is valid OpenAPI 3.1 (passes swagger-editor validation)
- `.context/` contains architecture, patterns, decisions, squad-memory
- `bun run ci` passes cleanly

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Integration test rewrite is large | High | Medium | Do it incrementally; keep old tests as `.skip` until new ones pass |
| Postgres test setup flaky | Medium | Medium | Use `testcontainers` or spin up ephemeral Postgres in `beforeAll` |
| OTEL sampling breaks debugging | Low | Low | Make sampling configurable via env var |
| Removing dead code breaks something unexpected | Low | High | Search all imports before deleting; run full test suite |

## Dependencies

- **Bun 1.2+** for runtime
- **Redis 7** for rate limiting and quota
- **PostgreSQL 16** for audit and usage history
- **Azure AI Foundry** endpoints for proxy targets

## Success Metrics

| Metric | Before | After |
|--------|--------|-------|
| CI pass rate | 0% | 100% |
| Test failures | 45 | 0 |
| Test coverage (lines) | 76.43% | ≥85% |
| Lint errors | 6 | 0 |
| TypeScript errors | 20 | 0 |
| Dead code files | 3 proxy apps | 0 |
| Uncommitted changes | 17 files | 0 |
| Hardcoded secrets | 2 | 0 |

---

*Plan created after deep codebase review. Ready for execution.*
