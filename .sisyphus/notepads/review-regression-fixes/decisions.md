## [2026-05-02T15:21:00Z] Decision: Test Mock Fix

### Root Cause
`quota.service.test.ts` mock factory only exposed `getUserQuotaPolicyByPatSubject`, missing `logRequestAudit`. When Bun runs tests as a suite, module cache is shared. The `openai-responses.proxy.test.ts` imports `data-access` without any mock — it needs the real `logRequestAudit` export. But when `quota.service.test.ts` ran before it, its incomplete mock was cached, so `openai-responses.proxy.test.ts` got a mock without `logRequestAudit`, causing the error.

### Fix Applied
Added `logRequestAudit: vi.fn()` to `quota.service.test.ts` mock factory:
```typescript
vi.mock('../../../src/db/data-access', () => ({
  resolveUserId: vi.fn(),
  logRequestAudit: vi.fn(),
  getUserQuotaPolicyByPatSubject: async () => { ... },
}));
```

### Result
- `bun test tests/unit/` → 467 pass, 0 fail, 0 errors
- All 3 proxy tests, middleware tests, and service tests pass individually

### Note
The proxy test mocks already had `resolveUserId: vi.fn()`. The real problem was the quota service mock missing `logRequestAudit`. This is module cache pollution — the FIRST mock to load for a module determines what all subsequent imports see.
