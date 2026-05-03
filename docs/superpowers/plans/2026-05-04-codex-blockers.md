# Codex 9.5 Hardening — Blocker Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four real bugs Codex 7.2/10 review uncovered (CTE parameter binding, streaming reconcile fail-open, fallback reservation underpricing, circuit-breaker probe TTL leak) plus delete one orphaned module, raising the production score to a verifiable 9.5/10.

**Architecture:** Five independent work items. Task 1 fixes silent data corruption in `batchGetRequestAuditStats` and ships a backfill script. Task 2 makes the streaming + non-streaming reconcile path fail-closed by promoting Postgres `request_audit` to billing source-of-truth, with an on-disk Write-Ahead-Log dead-letter queue and a periodic reconciler job for full dual-failure resilience. Task 3 adds atomic top-up for fallback reservations so model-substitution stays within budget policy. Task 4 adds a TTL safety net to the circuit-breaker half-open probe. Task 5 deletes a dead pricing module that masquerades as production code.

**Tech Stack:** Bun, Hono, Redis (ioredis + Lua), PostgreSQL (postgres.js), Node `fs/promises` (atomic writes), OpenTelemetry, Prometheus, decimal.js.

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/db/data-access.ts` | Replace literal-int CTE with `unnest($N::int[], ...)` pattern |
| Create | `scripts/backfill-usage-history.ts` | One-shot backfill for months corrupted by old CTE |
| Create | `tests/integration/db/audit-stats-batch.test.ts` | Postgres integration test for batch stats |
| Modify | `docs/operations/runbook-quota-drift.md` | Add backfill procedure |
| Modify | `src/proxy/shared.ts` | `finalizeProxyUsage` — durable audit + WAL on dual failure |
| Modify | `src/proxy/openai-chat.proxy.ts` | Streaming reconcile — durable audit + SSE error tail + WAL |
| Modify | `src/proxy/anthropic.proxy.ts` | Streaming reconcile — durable audit + SSE error tail + WAL |
| Create | `src/services/wal.service.ts` | Atomic on-disk WAL writer for unbilled requests |
| Modify | `src/services/scheduler.service.ts` | Add `runReconcilerJob` (rebuild `quota:*.spent` from PG) |
| Modify | `src/observability/metrics.ts` | Add `unbilled_requests_total` + `fallback_soft_overage_total` counters |
| Modify | `src/db/data-access.ts` (Task 2 — second edit) | Add `getMonthlySpentFromAudit(userId, month)` helper |
| Create | `tests/integration/proxy/redis-down-chaos.test.ts` | Chaos test: Redis-down during streaming reconcile |
| Create | `tests/unit/services/wal.service.test.ts` | Unit tests for WAL atomicity |
| Modify | `docs/operations/runbook-quota-drift.md` | Add WAL replay procedure |
| Modify | `src/services/quota/scripts.ts` | Add `TOP_UP_RESERVATION_SCRIPT` |
| Modify | `src/services/quota.service.ts` | Add `topUpReservation` function |
| Modify | `src/routes/factories/request-handler.factory.ts` | `tryFallbacks` — call `topUpReservation` per fallback |
| Create | `tests/unit/services/quota-topup.test.ts` | Unit tests for top-up Lua + soft/hard policy |
| Modify | `src/services/circuit-breaker.ts` | Add `PROBE_TTL_SECONDS`; both probe `set` calls use `EX` |
| Create | `tests/unit/services/circuit-breaker-probe-ttl.test.ts` | Assert probe TTL on success/NX paths |
| Delete | `src/config/pricing.ts` | Orphan module — no production imports |
| Delete | `tests/unit/config/pricing.test.ts` | Tests for the deleted orphan module |
| Modify | `tests/unit/services/pricing.service.test.ts` | Port any unique invariants from deleted test |

---

## Task 1: Fix `batchGetRequestAuditStats` CTE Parameter Bug + Ship Backfill

**Files:**
- Modify: `src/db/data-access.ts:114-188`
- Create: `scripts/backfill-usage-history.ts`
- Create: `tests/integration/db/audit-stats-batch.test.ts`
- Modify: `docs/operations/runbook-quota-drift.md`

**Context:** `batchGetRequestAuditStats` builds a CTE using literal integers `(${base}, ${base + 1}, ${base + 2})` rather than `($${base}, $${base + 1}, $${base + 2})`. The `$` is missing. The query emits `(VALUES (2, 3, 4), (5, 6, 7), ...)` instead of `(VALUES ($2, $3, $4), ($5, $6, $7), ...)`. Postgres then evaluates `make_date(2, 3, 1)` as year 2 AD / March / day 1, so every CROSS JOIN yields zero matching rows. `usage_history` archive rows for users without same-month writes have all-zero `total_requests`, `total_tokens_*` fields. Cost is correct (it's read directly from Redis `quota:*.spent`), but token aggregates are silently wrong.

**Why tests didn't catch it:** `tests/unit/services/scheduler.service.test.ts:45` mocks `batchGetRequestAuditStats` directly. There is no Postgres integration test exercising the real query.

**Approach:** Use `unnest($N::int[], $M::int[], $K::text[]) AS v(yr, mo, month)` which is the same pattern already used by `batchArchiveMonthlyUsage` in the same file. This eliminates the index-arithmetic bug class entirely. Then ship a one-shot backfill that re-archives any month already in `usage_history` where `request_audit` has matching data.

- [ ] **Step 1: Write the failing Postgres integration test**

Create `tests/integration/db/audit-stats-batch.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { batchGetRequestAuditStats } from '@/db/data-access';
import { database } from '@/db/client';
import { randomUUID } from 'node:crypto';

describe('batchGetRequestAuditStats — Postgres integration', () => {
  const userId = randomUUID();

  beforeAll(async () => {
    await database.execute({
      query: `INSERT INTO users (id, pat_subject, monthly_budget_usd, hard_limit)
              VALUES ($1, $2, 100, true)
              ON CONFLICT (id) DO NOTHING`,
      params: [userId, `pat-${userId}`],
    });
  });

  beforeEach(async () => {
    await database.execute({
      query: `DELETE FROM request_audit WHERE user_id = $1`,
      params: [userId],
    });
  });

  afterAll(async () => {
    await database.execute({
      query: `DELETE FROM request_audit WHERE user_id = $1`,
      params: [userId],
    });
    await database.execute({
      query: `DELETE FROM users WHERE id = $1`,
      params: [userId],
    });
  });

  test('aggregates token totals across two distinct months', async () => {
    // Insert 2 rows in 2026-04, 3 rows in 2026-05
    await database.execute({
      query: `
        INSERT INTO request_audit
          (request_id, user_id, model, deployment, protocol_family,
           tokens_input, tokens_output, tokens_thinking, cost_usd,
           thinking_enabled, azure_auth_type, duration_ms, status_code, created_at)
        VALUES
          ($1, $2, 'gpt-4o', 'gpt-4o', 'openai', 100, 50, 0, 0.01, false, 'apikey', 100, 200, '2026-04-15 12:00:00+00'),
          ($3, $2, 'gpt-4o', 'gpt-4o', 'openai', 200, 75, 0, 0.02, false, 'apikey', 100, 200, '2026-04-20 12:00:00+00'),
          ($4, $2, 'gpt-4o', 'gpt-4o', 'openai', 50, 25, 0, 0.005, false, 'apikey', 100, 200, '2026-05-01 12:00:00+00'),
          ($5, $2, 'gpt-4o', 'gpt-4o', 'openai', 60, 30, 0, 0.006, false, 'apikey', 100, 200, '2026-05-10 12:00:00+00'),
          ($6, $2, 'gpt-4o', 'gpt-4o', 'openai', 70, 35, 0, 0.007, false, 'apikey', 100, 200, '2026-05-25 12:00:00+00')
      `,
      params: [
        randomUUID(), userId, randomUUID(), randomUUID(), randomUUID(), randomUUID(),
      ],
    });

    const result = await batchGetRequestAuditStats([
      { resolvedUserId: userId, month: '2026-04' },
      { resolvedUserId: userId, month: '2026-05' },
    ]);

    const april = result.get(`${userId}:2026-04`);
    const may = result.get(`${userId}:2026-05`);

    expect(april).toBeDefined();
    expect(april?.totalRequests).toBe(2);
    expect(april?.totalTokensInput).toBe(300);
    expect(april?.totalTokensOutput).toBe(125);

    expect(may).toBeDefined();
    expect(may?.totalRequests).toBe(3);
    expect(may?.totalTokensInput).toBe(180);
    expect(may?.totalTokensOutput).toBe(90);
  });

  test('returns empty map for empty input', async () => {
    const result = await batchGetRequestAuditStats([]);
    expect(result.size).toBe(0);
  });

  test('does not include rows from adjacent months', async () => {
    // Insert one row in 2026-04 boundary, one in 2026-05 boundary
    await database.execute({
      query: `
        INSERT INTO request_audit
          (request_id, user_id, model, deployment, protocol_family,
           tokens_input, tokens_output, tokens_thinking, cost_usd,
           thinking_enabled, azure_auth_type, duration_ms, status_code, created_at)
        VALUES
          ($1, $2, 'gpt-4o', 'gpt-4o', 'openai', 100, 50, 0, 0.01, false, 'apikey', 100, 200, '2026-04-30 23:59:59+00'),
          ($3, $2, 'gpt-4o', 'gpt-4o', 'openai', 200, 100, 0, 0.02, false, 'apikey', 100, 200, '2026-05-01 00:00:00+00')
      `,
      params: [randomUUID(), userId, randomUUID()],
    });

    const result = await batchGetRequestAuditStats([
      { resolvedUserId: userId, month: '2026-04' },
    ]);

    const april = result.get(`${userId}:2026-04`);
    expect(april?.totalRequests).toBe(1);
    expect(april?.totalTokensInput).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/db/audit-stats-batch.test.ts`
Expected: FAIL — `april` and `may` are `undefined` (the broken `make_date(2, 3, 1)` matches no rows). Test must be skipped if `DATABASE_URL` is unset; assert via `if (!process.env.DATABASE_URL) return;` if needed for CI compatibility.

- [ ] **Step 3: Refactor `batchGetRequestAuditStats` to use `unnest`**

In `src/db/data-access.ts`, replace the function body (lines 114-188) with:

```typescript
export async function batchGetRequestAuditStats(
  entries: Array<{ resolvedUserId: string; month: string }>
): Promise<Map<string, AuditStats>> {
  const result = new Map<string, AuditStats>();

  if (entries.length === 0) return result;

  const userIds = [...new Set(entries.map((e) => e.resolvedUserId))];
  const uniqueMonths = [...new Set(entries.map((e) => e.month))];

  try {
    const years = uniqueMonths.map((m) => Number.parseInt(m.substring(0, 4), 10));
    const monthNums = uniqueMonths.map((m) => Number.parseInt(m.substring(5, 7), 10));

    const query = `
      WITH month_ranges AS (
        SELECT
          month,
          make_date(yr, mo, 1) AS month_start,
          make_date(yr, mo, 1) + INTERVAL '1 month' AS month_end
        FROM unnest($2::int[], $3::int[], $4::text[]) AS v(yr, mo, month)
      )
      SELECT
        r.user_id::text AS user_id,
        mr.month AS month,
        COUNT(*) AS total_requests,
        COALESCE(SUM(r.tokens_input), 0) AS total_tokens_input,
        COALESCE(SUM(r.tokens_output), 0) AS total_tokens_output,
        COALESCE(SUM(r.tokens_thinking), 0) AS total_tokens_thinking
      FROM request_audit r
      CROSS JOIN month_ranges mr
      WHERE r.user_id = ANY($1)
        AND r.created_at >= mr.month_start
        AND r.created_at < mr.month_end
      GROUP BY r.user_id, mr.month
    `;

    const params = [userIds, years, monthNums, uniqueMonths];

    const { rows } = await database.execute<{
      user_id: string;
      month: string;
      total_requests: string;
      total_tokens_input: string;
      total_tokens_output: string;
      total_tokens_thinking: string;
    }>({ query, params });

    for (const row of rows) {
      result.set(`${row.user_id}:${row.month}`, {
        totalRequests: Number(row.total_requests),
        totalTokensInput: Number(row.total_tokens_input),
        totalTokensOutput: Number(row.total_tokens_output),
        totalTokensThinking: Number(row.total_tokens_thinking),
      });
    }
  } catch (error) {
    logger.error({ error }, 'Failed to batch-query request audit stats');
  }

  return result;
}
```

- [ ] **Step 4: Run integration test to verify it passes**

Run: `bun test tests/integration/db/audit-stats-batch.test.ts`
Expected: PASS — all three tests green.

- [ ] **Step 5: Run full unit test suite to verify no regression**

Run: `bun test tests/unit`
Expected: ALL PASS (the existing scheduler test mocks this function so it stays green).

- [ ] **Step 6: Write the backfill script**

Create `scripts/backfill-usage-history.ts`:

```typescript
#!/usr/bin/env bun
/**
 * One-shot backfill for usage_history rows corrupted by the
 * batchGetRequestAuditStats CTE bug (literal ints instead of $N).
 *
 * Strategy:
 *   1. Find all (user_id, month) pairs in usage_history.
 *   2. For pairs where request_audit has rows in that month, recompute
 *      stats from request_audit and UPDATE usage_history.
 *   3. cost_usd is preserved (it came from Redis quota:*.spent and was
 *      always correct).
 *
 * Usage:
 *   bun scripts/backfill-usage-history.ts            # dry-run (default)
 *   bun scripts/backfill-usage-history.ts --apply    # write changes
 */
import { database } from '../src/db/client';
import { logger } from '../src/observability/logger';

const APPLY = process.argv.includes('--apply');

interface ArchiveRow {
  user_id: string;
  month: string;
  total_requests: number;
  total_tokens_input: number;
  total_tokens_output: number;
  total_tokens_thinking: number;
}

interface RecomputedStats {
  total_requests: number;
  total_tokens_input: number;
  total_tokens_output: number;
  total_tokens_thinking: number;
}

async function main(): Promise<void> {
  logger.info({ apply: APPLY }, 'Starting usage_history backfill');

  const { rows: archiveRows } = await database.execute<ArchiveRow>({
    query: `
      SELECT user_id::text AS user_id, month,
        total_requests, total_tokens_input,
        total_tokens_output, total_tokens_thinking
      FROM usage_history
      ORDER BY month, user_id
    `,
    params: [],
  });

  logger.info({ count: archiveRows.length }, 'Loaded archive rows');

  let candidates = 0;
  let updates = 0;

  for (const row of archiveRows) {
    const year = Number.parseInt(row.month.substring(0, 4), 10);
    const monthNum = Number.parseInt(row.month.substring(5, 7), 10);

    const { rows: stats } = await database.execute<RecomputedStats>({
      query: `
        SELECT
          COUNT(*)::int AS total_requests,
          COALESCE(SUM(tokens_input), 0)::int AS total_tokens_input,
          COALESCE(SUM(tokens_output), 0)::int AS total_tokens_output,
          COALESCE(SUM(tokens_thinking), 0)::int AS total_tokens_thinking
        FROM request_audit
        WHERE user_id = $1
          AND created_at >= make_date($2, $3, 1)
          AND created_at < make_date($2, $3, 1) + INTERVAL '1 month'
      `,
      params: [row.user_id, year, monthNum],
    });

    const recomputed = stats[0];
    if (!recomputed || recomputed.total_requests === 0) continue;

    const drift =
      recomputed.total_requests !== row.total_requests ||
      recomputed.total_tokens_input !== row.total_tokens_input ||
      recomputed.total_tokens_output !== row.total_tokens_output ||
      recomputed.total_tokens_thinking !== row.total_tokens_thinking;

    if (!drift) continue;

    candidates++;

    logger.info(
      {
        userId: row.user_id,
        month: row.month,
        before: {
          requests: row.total_requests,
          input: row.total_tokens_input,
          output: row.total_tokens_output,
          thinking: row.total_tokens_thinking,
        },
        after: recomputed,
      },
      'Drift detected'
    );

    if (APPLY) {
      await database.execute({
        query: `
          UPDATE usage_history
          SET total_requests = $3,
              total_tokens_input = $4,
              total_tokens_output = $5,
              total_tokens_thinking = $6
          WHERE user_id = $1 AND month = $2
        `,
        params: [
          row.user_id,
          row.month,
          recomputed.total_requests,
          recomputed.total_tokens_input,
          recomputed.total_tokens_output,
          recomputed.total_tokens_thinking,
        ],
      });
      updates++;
    }
  }

  logger.info({ candidates, updates, apply: APPLY }, 'Backfill complete');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'Backfill failed');
  process.exit(1);
});
```

- [ ] **Step 7: Add backfill section to runbook**

Append to `docs/operations/runbook-quota-drift.md`:

```markdown
## Usage History Backfill (CTE bug — pre-2026-05 archives)

`usage_history` rows archived before the `batchGetRequestAuditStats` CTE
fix (commit fixing index `($base, $base+1, ...)` → `unnest($N::int[], ...)`)
have all-zero `total_tokens_*` and `total_requests` because the broken
CTE matched no rows. `total_cost_usd` was always correct (read from Redis).

### Detection

```sql
SELECT user_id, month, total_requests, total_tokens_input
FROM usage_history
WHERE total_requests = 0
  AND EXISTS (
    SELECT 1 FROM request_audit r
    WHERE r.user_id = usage_history.user_id
      AND r.created_at >= make_date(
        CAST(SUBSTRING(usage_history.month FROM 1 FOR 4) AS int),
        CAST(SUBSTRING(usage_history.month FROM 6 FOR 2) AS int),
        1
      )
  );
```

### Fix

```bash
# Dry-run — log drift, no writes
bun scripts/backfill-usage-history.ts

# Apply
bun scripts/backfill-usage-history.ts --apply
```

The script is idempotent: re-runs are safe and update only rows that
still drift from `request_audit` ground truth.
```

- [ ] **Step 8: Validate backfill script compiles and dry-runs**

Run: `bun run typecheck && bun scripts/backfill-usage-history.ts`
Expected: typecheck clean; script connects to Postgres, logs drift count, exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/db/data-access.ts scripts/backfill-usage-history.ts \
       tests/integration/db/audit-stats-batch.test.ts \
       docs/operations/runbook-quota-drift.md
git commit -m "fix(db): use unnest for batchGetRequestAuditStats CTE

The CTE inlined param indices as literal integers (\`(2, 3, 4)\` instead
of \`(\$2, \$3, \$4)\`), so make_date(2, 3, 1) joined zero rows and every
archived month had zero token totals. Switch to unnest(\$N::int[], ...)
matching the pattern in batchArchiveMonthlyUsage.

Adds Postgres integration test and one-shot backfill script + runbook."
```

---

## Task 2: Postgres-as-Truth Streaming Reconcile + WAL Dead-Letter Queue

**Files:**
- Modify: `src/proxy/shared.ts` (`finalizeProxyUsage`)
- Modify: `src/proxy/openai-chat.proxy.ts` (streaming path)
- Modify: `src/proxy/anthropic.proxy.ts` (streaming path)
- Create: `src/services/wal.service.ts`
- Modify: `src/services/scheduler.service.ts` (add `runReconcilerJob`)
- Modify: `src/observability/metrics.ts` (`unbilled_requests_total` counter)
- Modify: `src/db/data-access.ts` (add `getMonthlySpentFromAudit`)
- Modify: `src/config/env.ts` (add `WAL_DIR` + `RECONCILER_INTERVAL_MS`)
- Create: `tests/unit/services/wal.service.test.ts`
- Create: `tests/integration/proxy/redis-down-chaos.test.ts`
- Modify: `docs/operations/runbook-quota-drift.md` (WAL replay procedure)

**Context:** The streaming proxies (`openai-chat.proxy.ts:285-315`, `anthropic.proxy.ts:351-409`) set `reservationFinalized = true` BEFORE calling `reconcileUsage`. When Redis fails, they throw `QuotaReconciliationError`, but the throw happens inside an async IIFE wrapped in `.catch((err) => logger.error(...))` at the call site (line 314 OpenAI). The error is swallowed. `releaseUnreconciled` (the `onEnd` handler) then short-circuits because `reservationFinalized` is already `true`. The 300s reservation TTL eventually frees the quota — the request becomes free.

`finalizeProxyUsage` in `shared.ts` (non-streaming path) is partially correct: it throws on reconcile failure, but the throw happens BEFORE `logRequestAudit` is called. So Postgres also has no record. There is no audit trail and no dead-letter queue.

**Architecture decision (locked):** Postgres `request_audit` becomes durable billing source-of-truth. Redis `quota:{userId}:{month}.spent` is a recoverable fast-path cache.

**Rules of the new flow (all paths, streaming + non-streaming):**

1. Compute `actualCost` from usage + model.
2. Call `reconcileUsage(reservationId, usage, model)` (Redis fast path).
3. **Always** attempt `logRequestAudit({...})` (Postgres durable). Retry up to 3 times with exponential backoff (200ms, 400ms, 800ms) before giving up.
4. **Branches:**
   - Redis OK + Postgres OK → done.
   - Redis OK + Postgres fail → write WAL row + `unbilled_requests_total++` (audit hole, reconciler job will eventually reconcile from Redis but PG row remains missing — WAL preserves it for replay).
   - Redis fail + Postgres OK → log warning, do NOT throw. Reconciler job will rebuild `quota:*.spent` from `SUM(cost_usd)` per minute.
   - Redis fail + Postgres fail → write WAL + `unbilled_requests_total++`. Streaming: emit synthetic SSE error tail. Non-streaming: return 502.
5. **Invariant:** `request_audit row exists OR WAL row exists OR client got 5xx`.

**Reconciler job:** Every `RECONCILER_INTERVAL_MS` (default 60_000ms), for each `quota:{userId}:{month}` key in current month: query `SELECT SUM(cost_usd) FROM request_audit WHERE user_id = $1 AND created_at >= month_start AND < month_end`, then `HSET quota:{userId}:{month} spent <total_micro>` if drift > tolerance (1 microdollar). Idempotent. Lock-protected like other scheduler jobs.

- [ ] **Step 1: Add `WAL_DIR` and `RECONCILER_INTERVAL_MS` to env config**

In `src/config/env.ts`, add to the Zod schema:

```typescript
WAL_DIR: z.string().default('/var/lib/llm-gateway/dlq'),
RECONCILER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
```

If the project uses `.env.example`, append:

```bash
# Write-Ahead-Log directory for unbilled requests (dual-failure DLQ)
WAL_DIR=/var/lib/llm-gateway/dlq

# Quota reconciler job interval (rebuilds Redis spent from Postgres)
RECONCILER_INTERVAL_MS=60000
```

- [ ] **Step 2: Add `unbilled_requests_total` counter to metrics**

In `src/observability/metrics.ts`, add to `inMemoryCounters`:

```typescript
unbilled_requests_total: 0,
```

Add the OTel counter export and increment helper:

```typescript
export const unbilledRequestsTotal = meter.createCounter('unbilled_requests_total', {
  description: 'Requests that completed without successful billing (WAL written)',
});

export function incrementUnbilledRequests(reason: 'redis_fail' | 'pg_fail' | 'both_fail'): void {
  unbilledRequestsTotal.add(1, { reason });
  incrementCounter('unbilled_requests_total');
}
```

- [ ] **Step 3: Write failing unit test for the WAL service**

Create `tests/unit/services/wal.service.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeWalEntry, readWalEntries, removeWalEntry } from '@/services/wal.service';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('WAL service', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wal-test-'));
    process.env.WAL_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writeWalEntry creates atomic file with expected content', async () => {
    await writeWalEntry({
      requestId: 'req-1',
      userId: 'user-1',
      model: 'gpt-4o',
      tokensInput: 100,
      tokensOutput: 50,
      tokensThinking: 0,
      costUsd: '0.001500',
      timestamp: new Date('2026-05-04T12:00:00Z').toISOString(),
      reason: 'both_fail',
    });

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('unbilled-req-1.json');

    const content = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    expect(content.requestId).toBe('req-1');
    expect(content.costUsd).toBe('0.001500');
    expect(content.reason).toBe('both_fail');
  });

  test('writeWalEntry uses tmp+rename for atomicity', async () => {
    await writeWalEntry({
      requestId: 'req-2',
      userId: 'user-2',
      model: 'gpt-4o',
      tokensInput: 1, tokensOutput: 1, tokensThinking: 0,
      costUsd: '0.000001',
      timestamp: new Date().toISOString(),
      reason: 'pg_fail',
    });
    // No leftover .tmp files after rename
    const tmpFiles = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  test('readWalEntries returns all unbilled-*.json files parsed', async () => {
    await writeWalEntry({
      requestId: 'req-3', userId: 'u', model: 'gpt-4o',
      tokensInput: 1, tokensOutput: 1, tokensThinking: 0,
      costUsd: '0.000001', timestamp: new Date().toISOString(), reason: 'redis_fail',
    });
    await writeWalEntry({
      requestId: 'req-4', userId: 'u', model: 'gpt-4o',
      tokensInput: 2, tokensOutput: 2, tokensThinking: 0,
      costUsd: '0.000002', timestamp: new Date().toISOString(), reason: 'redis_fail',
    });
    const entries = await readWalEntries();
    expect(entries).toHaveLength(2);
    const ids = entries.map((e) => e.requestId).sort();
    expect(ids).toEqual(['req-3', 'req-4']);
  });

  test('removeWalEntry deletes the file', async () => {
    await writeWalEntry({
      requestId: 'req-5', userId: 'u', model: 'gpt-4o',
      tokensInput: 1, tokensOutput: 1, tokensThinking: 0,
      costUsd: '0.000001', timestamp: new Date().toISOString(), reason: 'pg_fail',
    });
    expect(existsSync(join(dir, 'unbilled-req-5.json'))).toBe(true);
    await removeWalEntry('req-5');
    expect(existsSync(join(dir, 'unbilled-req-5.json'))).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test tests/unit/services/wal.service.test.ts`
Expected: FAIL — module `@/services/wal.service` does not exist.

- [ ] **Step 5: Implement the WAL service**

Create `src/services/wal.service.ts`:

```typescript
import { mkdir, rename, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '@/config/env';
import { logger } from '@/observability/logger';

export interface WalEntry {
  requestId: string;
  userId: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  tokensThinking: number;
  costUsd: string;
  timestamp: string;
  reason: 'redis_fail' | 'pg_fail' | 'both_fail';
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;

function walDir(): string {
  return process.env.WAL_DIR ?? env.WAL_DIR;
}

function entryPath(requestId: string): string {
  if (!SAFE_REQUEST_ID.test(requestId)) {
    throw new Error(`Invalid requestId for WAL: ${requestId}`);
  }
  return join(walDir(), `unbilled-${requestId}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(walDir(), { recursive: true, mode: 0o700 });
}

export async function writeWalEntry(entry: WalEntry): Promise<void> {
  await ensureDir();
  const finalPath = entryPath(entry.requestId);
  const tmpPath = `${finalPath}.tmp`;
  const body = `${JSON.stringify(entry)}\n`;
  try {
    await writeFile(tmpPath, body, { mode: 0o600 });
    await rename(tmpPath, finalPath);
  } catch (err) {
    logger.error({ err, requestId: entry.requestId }, 'Failed to write WAL entry');
    throw err;
  }
}

export async function readWalEntries(): Promise<WalEntry[]> {
  await ensureDir();
  let names: string[];
  try {
    names = await readdir(walDir());
  } catch (err) {
    logger.warn({ err }, 'Failed to list WAL directory');
    return [];
  }
  const entries: WalEntry[] = [];
  for (const name of names) {
    if (!name.startsWith('unbilled-') || !name.endsWith('.json')) continue;
    try {
      const text = await readFile(join(walDir(), name), 'utf8');
      entries.push(JSON.parse(text) as WalEntry);
    } catch (err) {
      logger.warn({ err, name }, 'Failed to read WAL entry; skipping');
    }
  }
  return entries;
}

export async function removeWalEntry(requestId: string): Promise<void> {
  try {
    await unlink(entryPath(requestId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err, requestId }, 'Failed to remove WAL entry');
    }
  }
}
```

- [ ] **Step 6: Run WAL unit tests to verify they pass**

Run: `bun test tests/unit/services/wal.service.test.ts`
Expected: PASS — all four cases green.

- [ ] **Step 7: Add `getMonthlySpentFromAudit` helper to data-access**

In `src/db/data-access.ts`, append:

```typescript
/**
 * Sum of cost_usd across request_audit for a user/month.
 * Used by the reconciler job to rebuild Redis quota.spent from durable
 * Postgres ground truth after Redis failures.
 */
export async function getMonthlySpentFromAudit(
  resolvedUserId: string,
  month: string
): Promise<string> {
  const year = Number.parseInt(month.substring(0, 4), 10);
  const monthNum = Number.parseInt(month.substring(5, 7), 10);

  try {
    const { rows } = await database.execute<{ total: string }>({
      query: `
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM request_audit
        WHERE user_id = $1
          AND created_at >= make_date($2, $3, 1)
          AND created_at < make_date($2, $3, 1) + INTERVAL '1 month'
      `,
      params: [resolvedUserId, year, monthNum],
    });
    return rows[0]?.total ?? '0';
  } catch (error) {
    logger.error(
      { error, resolvedUserId, month },
      'Failed to query monthly spent from audit'
    );
    return '0';
  }
}
```

- [ ] **Step 8: Refactor `finalizeProxyUsage` to durable-audit + WAL**

Replace `finalizeProxyUsage` in `src/proxy/shared.ts`. Add this helper above it:

```typescript
const PG_AUDIT_RETRIES = 3;
const PG_AUDIT_BACKOFF_MS = [200, 400, 800];

async function logRequestAuditDurable(
  payload: Parameters<typeof logRequestAudit>[0]
): Promise<boolean> {
  for (let attempt = 0; attempt < PG_AUDIT_RETRIES; attempt++) {
    try {
      await logRequestAudit(payload);
      return true;
    } catch (err) {
      logger.warn(
        { err, requestId: payload.requestId, attempt: attempt + 1 },
        'Postgres audit insert failed, retrying'
      );
      if (attempt < PG_AUDIT_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, PG_AUDIT_BACKOFF_MS[attempt]));
      }
    }
  }
  return false;
}
```

Replace `finalizeProxyUsage`:

```typescript
export async function finalizeProxyUsage({
  usage,
  reservationId,
  requestId,
  userId,
  deployment,
  startTime,
  thinkingEnabled = false,
  idempotencyKey,
}: FinalizeUsageOptions): Promise<void> {
  if (!usage) {
    if (reservationId) {
      await releaseReservedQuota(reservationId, requestId);
    }
    return;
  }

  // Step 1 — compute cost up front (we own this even if Redis is down)
  const actualCost: Decimal = (await import('@/services/pricing.service')).calculateCost(
    usage,
    deployment.azureModelName
  );

  // Step 2 — Redis reconcile (best-effort, fail-soft)
  let redisOk = true;
  if (reservationId) {
    const costResult = await reconcileUsage(reservationId, usage, deployment.azureModelName);
    if (!isOk(costResult)) {
      redisOk = false;
      logger.warn(
        { err: costResult.error, reservationId: costResult.error.reservationId, requestId },
        'Quota reconciliation failed - reconciler job will rebuild from Postgres'
      );
    }
  } else {
    // recordUsageOnly path - tolerate Redis failure same way
    try {
      await recordUsageOnly(
        userId || 'unknown',
        usage,
        deployment.azureModelName,
        idempotencyKey
      );
    } catch (err) {
      redisOk = false;
      logger.warn({ err, requestId }, 'recordUsageOnly failed - reconciler will rebuild');
    }
  }

  // Step 3 — span + metrics (in-memory, never throws)
  addLLMSpanAttributes({
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.prompt_tokens + usage.completion_tokens,
    costUsd: actualCost.toNumber(),
  });
  addLlmTokens(usage.prompt_tokens, usage.completion_tokens, deployment.azureModelName);
  addLlmCost(actualCost.toNumber(), deployment.azureModelName);
  recordLlmRequestDuration(
    Date.now() - startTime,
    deployment.azureModelName,
    deployment.protocolFamily
  );

  // Step 4 — durable Postgres audit (retried)
  const pgOk = await logRequestAuditDurable({
    userId: userId || 'unknown',
    requestId,
    model: deployment.azureModelName,
    deployment: deployment.name,
    protocolFamily: deployment.protocolFamily,
    tokensInput: usage.prompt_tokens,
    tokensOutput: usage.completion_tokens,
    tokensThinking: usage.thinking_tokens || 0,
    costUsd: actualCost.toString(),
    thinkingEnabled,
    azureAuthType: deployment.authConfig.type,
    durationMs: Date.now() - startTime,
    statusCode: 200,
  });

  // Step 5 — WAL on dual-failure (and pg-only failure: audit hole still needs WAL)
  if (!pgOk) {
    const reason = redisOk ? 'pg_fail' : 'both_fail';
    try {
      await writeWalEntry({
        requestId,
        userId: userId || 'unknown',
        model: deployment.azureModelName,
        tokensInput: usage.prompt_tokens,
        tokensOutput: usage.completion_tokens,
        tokensThinking: usage.thinking_tokens || 0,
        costUsd: actualCost.toString(),
        timestamp: new Date().toISOString(),
        reason,
      });
      incrementUnbilledRequests(reason);
    } catch (err) {
      logger.error({ err, requestId }, 'WAL write failed - data loss possible');
      incrementUnbilledRequests(reason);
    }

    if (!redisOk) {
      // Both failed: caller (non-streaming) must propagate 502
      const error = new Error('Quota reconciliation and audit both failed');
      error.name = 'QuotaReconciliationError';
      throw error;
    }
  }
}
```

Add the new imports near the top of `src/proxy/shared.ts`:

```typescript
import { incrementUnbilledRequests } from '@/observability/metrics';
import { writeWalEntry } from '@/services/wal.service';
```

- [ ] **Step 9: Refactor OpenAI streaming proxy reconcile path**

In `src/proxy/openai-chat.proxy.ts`, replace the `transformer` `onUsage` async IIFE body. After `if (reservationFinalized) return; reservationFinalized = true;`, replace the remaining body with:

```typescript
const finalizer = (await import('@/proxy/shared')).finalizeProxyUsage;
try {
  await finalizer({
    usage,
    reservationId,
    requestId,
    userId,
    deployment,
    startTime,
    thinkingEnabled: false,
  });
} catch (err) {
  // Dual-failure already wrote WAL + incremented metric inside finalizer
  logger.error({ err, requestId }, 'Streaming finalize failed - WAL persisted');
  // Emit synthetic SSE error tail so client knows
  // (write into the controller; see Step 10 for the streaming wrapper change)
  // We rely on transformer.controllerError set by the wrapper.
  if (transformer.emitError) {
    transformer.emitError(
      'quota_reconciliation_failed',
      'Server failed to record usage; request stored to dead-letter queue'
    );
  }
}
```

- [ ] **Step 10: Extend `createOpenAIStreamTransformer` with `emitError`**

In `src/utils/streaming.ts` (or wherever `createOpenAIStreamTransformer` lives — verify path with `grep -r createOpenAIStreamTransformer src/`), expose a controller-bound `emitError` on the returned transformer object:

```typescript
export function createOpenAIStreamTransformer(opts: {
  onUsage: (usage: TokenUsage) => void;
  onEnd: () => void | Promise<void>;
}): { transform: TransformerFn; flush: FlusherFn; emitError: (code: string, msg: string) => void } {
  let controllerRef: TransformStreamDefaultController<Uint8Array> | null = null;
  // ... existing state ...

  function emitError(code: string, message: string): void {
    if (!controllerRef) return;
    const errEvent = `data: ${JSON.stringify({
      error: { type: 'server_error', code, message },
    })}\n\n`;
    controllerRef.enqueue(new TextEncoder().encode(errEvent));
    const done = `data: [DONE]\n\n`;
    controllerRef.enqueue(new TextEncoder().encode(done));
  }

  return {
    transform: (chunk, controller) => {
      controllerRef = controller;
      // ... existing transform logic ...
    },
    flush: async (controller) => {
      controllerRef = controller;
      // ... existing flush logic ...
    },
    emitError,
  };
}
```

Apply the same pattern to `createAnthropicStreamTransformer` if separate — emit `event: error\ndata: {...}\n\n` for SSE shape compatibility with Anthropic clients.

- [ ] **Step 11: Refactor Anthropic streaming proxy reconcile path**

Apply the same change to `src/proxy/anthropic.proxy.ts:351-409` — replace the inline reconcile + audit + tracing block with a single `finalizeProxyUsage(...)` call wrapped in `try/catch` that calls `transformer.emitError` on failure (Anthropic-shape: `event: error\ndata: {...}`).

- [ ] **Step 12: Add the reconciler job to scheduler**

In `src/services/scheduler.service.ts`, add at the top of imports:

```typescript
import { batchResolveUserIds, getMonthlySpentFromAudit } from '@/db/data-access';
import { env } from '@/config/env';
```

Add new state and function:

```typescript
let reconcilerInterval: ReturnType<typeof setInterval> | null = null;
let reconcilerRunning = false;

const RECONCILER_DRIFT_TOLERANCE_MICRO = 1; // 1 microdollar

export async function runReconcilerJob(): Promise<void> {
  if (reconcilerRunning) return;
  reconcilerRunning = true;

  const lockKey = 'scheduler:reconciler:lock';
  if (!(await acquireLock(lockKey))) {
    reconcilerRunning = false;
    return;
  }

  try {
    const month = currentMonthKey();
    const pattern = `quota:*:${month}`;
    let cursor = '0';
    let scanIterations = 0;
    const userIds = new Set<string>();

    do {
      scanIterations++;
      if (scanIterations > MAX_SCAN_ITERATIONS) break;
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length >= 3) userIds.add(parts[1]);
      }
    } while (cursor !== '0');

    if (userIds.size === 0) return;

    const resolveMap = await batchResolveUserIds([...userIds]);
    let drifted = 0;

    for (const patUserId of userIds) {
      const resolved = resolveMap.get(patUserId);
      if (!resolved) continue;

      const truthMicro = await getMonthlySpentFromAudit(resolved, month);
      const truthBig = BigInt(truthMicro.replace('.', '').padEnd(7, '0').slice(0, -1)); // skip — see note
      // NOTE: cost_usd is stored as USD with 6 decimals. Convert to micro by mult 1e6.
      // Use Decimal for accuracy:
      const truthMicroExact = (await import('decimal.js')).default(truthMicro)
        .times(1_000_000)
        .toFixed(0);

      const quotaKey = `quota:${patUserId}:${month}`;
      const currentSpent = await redis.hget(quotaKey, 'spent');
      const currentMicro = currentSpent ?? '0';

      const driftAbs = Math.abs(Number(truthMicroExact) - Number(currentMicro));
      if (driftAbs > RECONCILER_DRIFT_TOLERANCE_MICRO) {
        await redis.hset(quotaKey, 'spent', truthMicroExact);
        drifted++;
        logger.info(
          {
            userId: patUserId,
            month,
            before: currentMicro,
            after: truthMicroExact,
            drift: driftAbs,
          },
          'Reconciler corrected quota.spent drift'
        );
      }
    }

    if (drifted > 0) {
      logger.info({ drifted, scanned: userIds.size }, 'Reconciler job complete');
    }
  } catch (error) {
    logger.error({ error }, 'Reconciler job failed');
  } finally {
    await releaseLock(lockKey);
    reconcilerRunning = false;
  }
}
```

Wire into `startBackgroundJobs` / `stopBackgroundJobs`:

```typescript
export function startBackgroundJobs(): void {
  if (cleanupInterval !== null || archiveInterval !== null || reconcilerInterval !== null) {
    return;
  }

  cleanupInterval = setInterval(runCleanupJob, CLEANUP_INTERVAL_MS);
  archiveInterval = setInterval(runArchiveJob, ARCHIVE_INTERVAL_MS);
  reconcilerInterval = setInterval(runReconcilerJob, env.RECONCILER_INTERVAL_MS);

  if (cleanupInterval.unref) cleanupInterval.unref();
  if (archiveInterval.unref) archiveInterval.unref();
  if (reconcilerInterval.unref) reconcilerInterval.unref();

  logger.info('Background jobs started');
}

export function stopBackgroundJobs(): void {
  if (cleanupInterval !== null) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (archiveInterval !== null) {
    clearInterval(archiveInterval);
    archiveInterval = null;
  }
  if (reconcilerInterval !== null) {
    clearInterval(reconcilerInterval);
    reconcilerInterval = null;
  }
  logger.info('Background jobs stopped');
}
```

- [ ] **Step 13: Write the chaos test**

Create the directory if needed: `mkdir -p tests/integration/proxy`. Then create `tests/integration/proxy/redis-down-chaos.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Streaming reconcile fail-closed (Redis-down chaos)', () => {
  const walDir = mkdtempSync(join(tmpdir(), 'chaos-wal-'));
  const originalWalDir = process.env.WAL_DIR;

  beforeAll(() => {
    process.env.WAL_DIR = walDir;
  });

  afterAll(() => {
    rmSync(walDir, { recursive: true, force: true });
    if (originalWalDir) process.env.WAL_DIR = originalWalDir;
    else delete process.env.WAL_DIR;
  });

  test('Redis reconcile failure during stream → audit row + no WAL (PG OK)', async () => {
    // Setup: mock reconcileUsage to return err({...redis_error...}),
    // mock logRequestAudit to resolve, run a fake stream through the OpenAI proxy
    // transformer, then assert:
    //   1. logRequestAudit was called with cost > 0
    //   2. WAL dir is empty (no unbilled-*.json)
    //   3. unbilled_requests_total NOT incremented for redis_fail (only pg_fail/both_fail trigger WAL)
    //   Wait — per the locked design, redis_fail alone does NOT WAL because PG is the
    //   audit guarantee. Reconciler will rebuild from PG.
    //
    // (Actual test code: mock the redis module + database module; invoke
    // finalizeProxyUsage directly with a known reservation+usage; assert WAL files;
    // see existing tests/integration/proxy patterns for mock binding.)
    expect(true).toBe(true); // placeholder — fill in with concrete mocks per existing patterns
  });

  test('PG audit failure during stream → WAL written + metric incremented', async () => {
    // Mock reconcileUsage to ok(), mock logRequestAudit to reject for all 3 retries.
    // Invoke finalizeProxyUsage. Assert:
    //   1. unbilled-{requestId}.json exists in WAL dir
    //   2. JSON contents match {requestId, userId, costUsd, reason: 'pg_fail'}
    //   3. unbilled_requests_total counter has incremented
    expect(true).toBe(true); // fill in with concrete mocks
  });

  test('Both Redis + PG fail → WAL written + SSE error tail emitted + metric incremented', async () => {
    // Mock both. Drive a fake response stream through the OpenAI streaming proxy.
    // Assert:
    //   1. WAL file exists with reason: 'both_fail'
    //   2. The piped stream output contains 'quota_reconciliation_failed' SSE event
    //   3. unbilled_requests_total counter has incremented
    expect(true).toBe(true); // fill in with concrete mocks
  });

  test('Reconciler job rebuilds Redis spent from Postgres', async () => {
    // Insert request_audit rows with known costs in current month.
    // Set Redis quota:{userId}:{month}.spent to 0.
    // Run runReconcilerJob().
    // Assert: redis.hget('quota:{userId}:{month}', 'spent') == sum * 1_000_000
    expect(true).toBe(true); // fill in with mock binding
  });
});
```

> **NOTE for implementer:** The placeholders above are intentional structure. Use the same mock pattern as `tests/integration/proxy/*.test.ts` that already exist (look for `bindMockRedis`, `vi.mock('@/db/data-access')`). Each test must drive a real call, set up real assertions, and assert real file/metric state — no `expect(true).toBe(true)`.

- [ ] **Step 14: Run chaos test to verify it fails (or shape works)**

Run: `bun test tests/integration/proxy/redis-down-chaos.test.ts`
Expected: PASS (with full mocked implementations).

- [ ] **Step 15: Run full test suite**

Run: `bun test`
Expected: ALL PASS, no regressions.

- [ ] **Step 16: Add WAL replay procedure to runbook**

Append to `docs/operations/runbook-quota-drift.md`:

```markdown
## WAL Replay (Unbilled Requests Dead-Letter Queue)

When `unbilled_requests_total` increments, JSON entries appear in `WAL_DIR`
(default `/var/lib/llm-gateway/dlq`). Each file is an atomic, complete
record of a request that ran but could not be billed at the time.

### Detection

```bash
ls -lh "$WAL_DIR"/unbilled-*.json | wc -l
```

Or query Prometheus: `unbilled_requests_total > 0`.

### Replay

```bash
# Inspect a single entry
cat "$WAL_DIR"/unbilled-<requestId>.json | jq

# Replay procedure (manual until automation lands):
#   1. For each WAL file, INSERT into request_audit with the captured
#      cost_usd / token counts / timestamp.
#   2. Verify reconciler job rebuilds quota.spent on next tick.
#   3. Delete the WAL file once Postgres row is confirmed.

bun scripts/replay-wal.ts --apply   # (script ships in a follow-up task)
```

The reconciler job (`runReconcilerJob`, default 60s interval) ensures
Redis `quota:{userId}:{month}.spent` matches `SUM(cost_usd)` from
`request_audit`. WAL replay therefore restores both billing AND quota
enforcement state in one step.
```

- [ ] **Step 17: Commit**

```bash
git add src/proxy/shared.ts src/proxy/openai-chat.proxy.ts src/proxy/anthropic.proxy.ts \
       src/services/wal.service.ts src/services/scheduler.service.ts \
       src/observability/metrics.ts src/db/data-access.ts src/config/env.ts \
       src/utils/streaming.ts \
       tests/unit/services/wal.service.test.ts \
       tests/integration/proxy/redis-down-chaos.test.ts \
       docs/operations/runbook-quota-drift.md .env.example
git commit -m "feat(quota): postgres-as-truth streaming reconcile + WAL DLQ

Streaming + non-streaming proxies now write a durable request_audit row
before stream end, retried with exponential backoff. Redis reconcile
failure no longer drops billing — reconciler job rebuilds quota.spent
from SUM(cost_usd) every minute. Dual-failure path writes JSON WAL to
disk, emits SSE error tail (streaming) or 502 (non-streaming), and
increments unbilled_requests_total. Invariant: request_audit row
exists OR WAL row exists OR client got 5xx."
```

---

## Task 3: Fallback Reservation Top-Up

**Files:**
- Modify: `src/services/quota/scripts.ts` (add `TOP_UP_RESERVATION_SCRIPT`)
- Modify: `src/services/quota.service.ts` (add `topUpReservation`)
- Modify: `src/routes/factories/request-handler.factory.ts` (`tryFallbacks`)
- Modify: `src/observability/metrics.ts` (`fallback_soft_overage_total`)
- Create: `tests/unit/services/quota-topup.test.ts`

**Context:** `tryFallbacks` in `request-handler.factory.ts:90-155` iterates `getFallbackChain(deployment)` reusing the original `reservationId`. The reservation amount was sized for the original (cheapest) deployment. If the fallback is more expensive, reconciliation pays actual cost regardless — but the reservation never reflected the true commitment, so other concurrent requests may have been allowed in over budget. Bounded overspend per request.

**Approach:** Before each fallback attempt, compute `delta = fallbackEstimatedCost - originalReservationAmount`. If positive, atomically top up the reservation. Respect existing soft/hard quota policy:

- `hard_limit=true` → top-up rejected → skip fallback, try next cheaper one. If chain exhausted → 429 (handled by existing flow returning `null`).
- `hard_limit=false` → log warning, allow fallback, mark audit row `soft_overage=true`, increment `fallback_soft_overage_total{model="<fallback>"}`.

The Lua script atomically:
1. Validates `quotaKey.budget`, `quotaKey.hard_limit`.
2. Reads current `reserved` and reservation data.
3. If `spent + reserved + delta <= budget` OR `hard_limit=false`, increments `reservedKey` by `delta` and rewrites `reservationKey` data with new amount.
4. Returns `{ok, mode}` where `mode` ∈ `{'within_budget', 'soft_overage', 'hard_rejected'}`.

- [ ] **Step 1: Write failing unit test**

Create `tests/unit/services/quota-topup.test.ts`:

> **Project test convention:** `MockRedis` lives at `tests/integration/helpers/mock-redis.ts`. Each unit test file inlines its own `bindMockRedis(mock)` helper that binds mock methods onto the real `redis` import (see `tests/unit/services/circuit-breaker.test.ts:14-30` for the canonical pattern). Reuse that pattern verbatim — do not import a non-existent `@/test-utils/mock-redis`.

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Decimal } from 'decimal.js';
import { MockRedis } from '../../integration/helpers/mock-redis';
import { redis } from '../../../src/db/redis';
import { topUpReservation, checkAndReserve } from '../../../src/services/quota.service';

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as Record<string, unknown>;
  r.get = mock.get.bind(mock);
  r.set = mock.set.bind(mock);
  r.setex = mock.setex.bind(mock);
  r.eval = mock.eval.bind(mock);
  r.hget = mock.hget.bind(mock);
  r.hgetall = mock.hgetall.bind(mock);
  r.hset = mock.hset.bind(mock);
  r.pipeline = mock.pipeline.bind(mock);
  r.incrbyfloat = mock.incrbyfloat.bind(mock);
  r.del = mock.del.bind(mock);
  r.ping = mock.ping.bind(mock);
  r.scan = mock.scan.bind(mock);
  r.ttl = mock.ttl.bind(mock);
  r.incrby = (mock as unknown as { incrby: (...a: unknown[]) => unknown }).incrby?.bind(mock);
}

describe('topUpReservation', () => {
  let mock: MockRedis;

  beforeEach(() => {
    mock = new MockRedis();
    bindMockRedis(mock);
  });

  afterEach(() => {
    mock.flushAll();
  });

  test('within budget — top-up succeeds and increments reserved', async () => {
    // Budget: $1.00 = 1_000_000 micro
    // Spent: $0
    // Initial reserve: $0.10
    // Delta: $0.30 (total reserve becomes $0.40, well within budget)
    await mock.hset('quota:user-1:2026-05', { budget: '1000000', spent: '0', hard_limit: '1' });
    const r = await checkAndReserve('user-1', new Decimal('0.10'));
    expect(r.allowed).toBe(true);

    const result = await topUpReservation(r.reservationId!, new Decimal('0.30'));
    expect(result.mode).toBe('within_budget');
    expect(result.allowed).toBe(true);

    const reserved = await mock.get('reserved:user-1:2026-05');
    expect(reserved).toBe('400000'); // $0.40 in microdollars
  });

  test('hard_limit=true and over budget — top-up rejected', async () => {
    await mock.hset('quota:user-2:2026-05', { budget: '1000000', spent: '900000', hard_limit: '1' });
    const r = await checkAndReserve('user-2', new Decimal('0.05'));
    expect(r.allowed).toBe(true);
    // Now top up by $0.20 — would exceed budget (900k + 50k + 200k = 1.15M > 1M)
    const result = await topUpReservation(r.reservationId!, new Decimal('0.20'));
    expect(result.mode).toBe('hard_rejected');
    expect(result.allowed).toBe(false);
    // Reserved should NOT have changed
    const reserved = await mock.get('reserved:user-2:2026-05');
    expect(reserved).toBe('50000');
  });

  test('hard_limit=false and over budget — top-up allowed with soft_overage', async () => {
    await mock.hset('quota:user-3:2026-05', { budget: '1000000', spent: '900000', hard_limit: '0' });
    const r = await checkAndReserve('user-3', new Decimal('0.05'));
    expect(r.allowed).toBe(true);
    const result = await topUpReservation(r.reservationId!, new Decimal('0.20'));
    expect(result.mode).toBe('soft_overage');
    expect(result.allowed).toBe(true);
    const reserved = await mock.get('reserved:user-3:2026-05');
    expect(reserved).toBe('250000'); // $0.25 in microdollars
  });

  test('zero delta — no-op', async () => {
    await mock.hset('quota:user-4:2026-05', { budget: '1000000', spent: '0', hard_limit: '1' });
    const r = await checkAndReserve('user-4', new Decimal('0.10'));
    const result = await topUpReservation(r.reservationId!, new Decimal('0'));
    expect(result.mode).toBe('within_budget');
    expect(result.allowed).toBe(true);
    const reserved = await mock.get('reserved:user-4:2026-05');
    expect(reserved).toBe('100000');
  });

  test('negative delta (cheaper fallback) — decrements reserved', async () => {
    await mock.hset('quota:user-5:2026-05', { budget: '1000000', spent: '0', hard_limit: '1' });
    const r = await checkAndReserve('user-5', new Decimal('0.50'));
    const result = await topUpReservation(r.reservationId!, new Decimal('-0.30'));
    expect(result.mode).toBe('within_budget');
    expect(result.allowed).toBe(true);
    const reserved = await mock.get('reserved:user-5:2026-05');
    expect(reserved).toBe('200000');
  });

  test('reservation not found — returns not_found', async () => {
    const result = await topUpReservation('nonexistent-id', new Decimal('0.10'));
    expect(result.mode).toBe('not_found');
    expect(result.allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/services/quota-topup.test.ts`
Expected: FAIL — `topUpReservation` not exported.

- [ ] **Step 3: Add `TOP_UP_RESERVATION_SCRIPT` to scripts.ts**

In `src/services/quota/scripts.ts`, append:

```typescript
export const TOP_UP_RESERVATION_SCRIPT = `
  local quotaKey = KEYS[1]
  local reservationKey = KEYS[2]
  local deltaMicro = tonumber(ARGV[1])
  local reservationId = ARGV[2]
  local defaultBudget = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[4])
  local reservedPrefix = ARGV[5]
  local hashPrefix = ARGV[6]

  local data = redis.call('get', reservationKey)
  if not data then
    return {0, 'not_found'}
  end

  local amountMicroStr, userId, month, createdAt
  local idx = 0
  for part in string.gmatch(data, '[^|]+') do
    if idx == 0 then amountMicroStr = part
    elseif idx == 1 then userId = part
    elseif idx == 2 then month = part
    elseif idx == 3 then createdAt = part
    end
    idx = idx + 1
  end

  if not amountMicroStr or not userId or not month then
    return {0, 'parse_error'}
  end

  local amountMicro = tonumber(amountMicroStr)
  local newAmount = amountMicro + deltaMicro
  if newAmount < 0 then newAmount = 0 end

  local reservedKey = reservedPrefix .. userId .. ':' .. month
  local hashKey = hashPrefix .. userId .. ':' .. month

  -- Soft/hard policy check only matters when delta > 0
  if deltaMicro > 0 then
    local budget = tonumber(redis.call('hget', quotaKey, 'budget') or defaultBudget)
    local spent = tonumber(redis.call('hget', quotaKey, 'spent') or 0)
    local reserved = tonumber(redis.call('get', reservedKey) or 0)
    local hardLimit = redis.call('hget', quotaKey, 'hard_limit')
    -- hard_limit defaults to '1' (true) when unset
    local isHard = (hardLimit ~= '0' and hardLimit ~= 'false')

    if spent + reserved + deltaMicro > budget then
      if isHard then
        return {0, 'hard_rejected'}
      end
      -- soft overage path falls through and applies the top-up
      redis.call('incrby', reservedKey, deltaMicro)
      local newData = newAmount .. '|' .. userId .. '|' .. month .. '|' .. (createdAt or '0')
      redis.call('set', reservationKey, newData, 'EX', ttl)
      redis.call('hset', hashKey, reservationId, newData)
      return {1, 'soft_overage'}
    end
  end

  redis.call('incrby', reservedKey, deltaMicro)
  local newData = newAmount .. '|' .. userId .. '|' .. month .. '|' .. (createdAt or '0')
  redis.call('set', reservationKey, newData, 'EX', ttl)
  redis.call('hset', hashKey, reservationId, newData)
  return {1, 'within_budget'}
`;
```

- [ ] **Step 4: Add `topUpReservation` to quota.service.ts**

In `src/services/quota.service.ts`, add the new import:

```typescript
import {
  CHECK_AND_RESERVE_SCRIPT,
  CLEANUP_ORPHAN_SCRIPT,
  RECONCILE_USAGE_SCRIPT,
  RELEASE_RESERVATION_SCRIPT,
  TOP_UP_RESERVATION_SCRIPT,
} from './quota/scripts';
```

Append after `releaseReservation`:

```typescript
export interface TopUpResult {
  allowed: boolean;
  mode: 'within_budget' | 'soft_overage' | 'hard_rejected' | 'not_found' | 'parse_error' | 'error';
}

export async function topUpReservation(
  reservationId: string,
  delta: Decimal
): Promise<TopUpResult> {
  const reservationKey = getReservationKey(reservationId);
  const deltaMicro = toMicrodollars(delta);

  // We need quotaKey, but we don't know userId/month yet. Lua reads it from
  // reservation data. Pass quotaKey placeholder — Lua reconstructs the real one
  // from reservation data internally? No — keep it simple: the script needs the
  // real quotaKey for budget/hard_limit lookups. Read reservation first.
  let userId: string;
  let month: string;
  try {
    const data = await redis.get(reservationKey);
    if (!data) return { allowed: false, mode: 'not_found' };
    const parts = data.split('|');
    if (parts.length < 3) return { allowed: false, mode: 'parse_error' };
    userId = parts[1];
    month = parts[2];
  } catch (error) {
    logger.error({ error, reservationId }, 'Top-up: failed to read reservation');
    return { allowed: false, mode: 'error' };
  }

  const quotaKey = getQuotaKey(userId, month);

  try {
    const result = (await redis.eval(
      TOP_UP_RESERVATION_SCRIPT,
      2,
      quotaKey,
      reservationKey,
      String(deltaMicro),
      reservationId,
      DEFAULT_BUDGET_MICRO,
      RESERVATION_TTL_SECONDS,
      RESERVED_KEY_PREFIX,
      RESERVATION_HASH_PREFIX
    )) as (string | number)[];

    const ok = result[0] === 1;
    const mode = result[1] as TopUpResult['mode'];
    return { allowed: ok, mode };
  } catch (error) {
    logger.error({ error, reservationId }, 'Top-up reservation error');
    return { allowed: false, mode: 'error' };
  }
}
```

- [ ] **Step 5: Run unit tests to verify they pass**

Run: `bun test tests/unit/services/quota-topup.test.ts`
Expected: PASS — all six cases green.

- [ ] **Step 6: Add `fallback_soft_overage_total` metric**

In `src/observability/metrics.ts`:

```typescript
// in inMemoryCounters
fallback_soft_overage_total: 0,

// add export
export const fallbackSoftOverageTotal = meter.createCounter('fallback_soft_overage_total', {
  description: 'Fallback chain top-ups that exceeded hard budget on soft-limit accounts',
});

export function incrementFallbackSoftOverage(model: string): void {
  fallbackSoftOverageTotal.add(1, { model: normalizeMetricModel(model) });
  incrementCounter('fallback_soft_overage_total');
}
```

- [ ] **Step 7: Wire `topUpReservation` into `tryFallbacks`**

In `src/routes/factories/request-handler.factory.ts`, edit the `for (const fallback of fallbackChain)` loop body. Before the `proxyStreaming/proxyNonStreaming` call:

```typescript
// Estimate fallback cost for top-up (use cheap heuristic: input tokens × output rate)
// In practice the existing token-estimation pipeline already produces an estimate;
// reuse it here via getEstimateForDeployment helper if present, else recompute.
const fallbackEstimate = await (await import('@/utils/tokens')).estimateRequestCost(
  options.bodyRecord,
  fallback
);
const originalReserved = await getReservedAmountForReservation(
  options.proxyContext.reservationId
);
const delta = fallbackEstimate.minus(originalReserved);

if (delta.gt(0)) {
  const topUp = await (await import('@/services/quota.service')).topUpReservation(
    options.proxyContext.reservationId,
    delta
  );
  if (topUp.mode === 'hard_rejected') {
    logger.info(
      { reservationId: options.proxyContext.reservationId, fallback: fallback.name },
      'Skipping fallback — top-up rejected by hard limit'
    );
    continue; // try next cheaper fallback
  }
  if (topUp.mode === 'soft_overage') {
    incrementFallbackSoftOverage(fallback.azureModelName);
    options.span.setAttribute('llm.soft_overage', true);
    logger.warn(
      { reservationId: options.proxyContext.reservationId, fallback: fallback.name, delta: delta.toString() },
      'Fallback proceeding with soft overage'
    );
  }
  if (topUp.mode === 'not_found' || topUp.mode === 'error' || topUp.mode === 'parse_error') {
    logger.error(
      { reservationId: options.proxyContext.reservationId, mode: topUp.mode },
      'Top-up failed; skipping fallback to avoid silent overspend'
    );
    continue;
  }
}
```

Helper `getReservedAmountForReservation`:

```typescript
async function getReservedAmountForReservation(reservationId: string): Promise<Decimal> {
  const { redis } = await import('@/db/redis');
  const { getReservationKey } = await import('@/services/quota/keys');
  const data = await redis.get(getReservationKey(reservationId));
  if (!data) return new Decimal(0);
  const parts = data.split('|');
  if (parts.length < 1) return new Decimal(0);
  return new Decimal(parts[0]).dividedBy(1_000_000);
}
```

> **NOTE:** If `estimateRequestCost(bodyRecord, deployment)` does not yet exist with this exact signature, factor a small helper out of the existing token-estimation pipeline used in the quota middleware. Do not duplicate logic.

- [ ] **Step 8: Run full test suite**

Run: `bun test`
Expected: ALL PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add src/services/quota/scripts.ts src/services/quota.service.ts \
       src/routes/factories/request-handler.factory.ts \
       src/observability/metrics.ts \
       tests/unit/services/quota-topup.test.ts
git commit -m "feat(quota): atomic top-up for fallback chain reservations

Each fallback attempt now computes delta = fallback_estimate - reserved
and atomically tops up via Lua. hard_limit=true rejects → try next
cheaper fallback. hard_limit=false logs soft_overage and proceeds.
Adds fallback_soft_overage_total counter."
```

---

## Task 4: Circuit-Breaker Probe Key TTL Safety Net

**Files:**
- Modify: `src/services/circuit-breaker.ts`
- Create: `tests/unit/services/circuit-breaker-probe-ttl.test.ts`

**Context:** `IS_REQUEST_ALLOWED_SCRIPT` calls `redis.call('set', probeKey, '1')` (line 80) when transitioning OPEN→HALF_OPEN, and `redis.call('set', probeKey, '1', 'NX')` (line 87) on subsequent HALF_OPEN gates. Neither sets `EX`. If the probe request crashes, throws unhandled, or the process dies between `set` and the `del` in `recordSuccess` / `recordFailure`, the probe key stays forever. All subsequent requests on this deployment hit `set NX` → returns nil → request rejected. The deployment is silently locked out until manual `redis del`.

**Approach:** Add `PROBE_TTL_SECONDS` constant sized to comfortably exceed `REQUEST_TIMEOUT_MS` (we use `Math.ceil(REQUEST_TIMEOUT_MS / 1000) + 5`, defaulting to 35s). Apply `'EX', PROBE_TTL_SECONDS` to both `set` calls. Successful probe paths still explicitly DEL the key.

- [ ] **Step 1: Write failing test**

Create `tests/unit/services/circuit-breaker-probe-ttl.test.ts`:

> **Reuse the existing `bindMockRedis` pattern from `tests/unit/services/circuit-breaker.test.ts:14-30`** — copy the helper inline rather than importing a non-existent module.

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MockRedis } from '../../integration/helpers/mock-redis';
import { redis } from '../../../src/db/redis';
import {
  isRequestAllowed,
  recordFailure,
  resetCircuitBreaker,
} from '../../../src/services/circuit-breaker';

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as Record<string, unknown>;
  r.get = mock.get.bind(mock);
  r.set = mock.set.bind(mock);
  r.setex = mock.setex.bind(mock);
  r.eval = mock.eval.bind(mock);
  r.hget = mock.hget.bind(mock);
  r.hgetall = mock.hgetall.bind(mock);
  r.hset = mock.hset.bind(mock);
  r.del = mock.del.bind(mock);
  r.ttl = mock.ttl.bind(mock);
  r.scan = mock.scan.bind(mock);
}

describe('Circuit breaker probe key TTL', () => {
  let mock: MockRedis;
  const dep = 'test-deployment';

  beforeEach(() => {
    mock = new MockRedis();
    bindMockRedis(mock);
  });

  afterEach(async () => {
    await resetCircuitBreaker(dep);
  });

  test('OPEN→HALF_OPEN transition sets probe key with TTL', async () => {
    // Force state to OPEN with nextAttemptTime in past
    await mock.hset(`circuit:${dep}`, {
      state: 'OPEN',
      failureCount: '5',
      nextAttemptTime: String(Date.now() - 1000),
    });
    const allowed = await isRequestAllowed(dep);
    expect(allowed).toBe(true);
    const ttl = await mock.ttl(`circuit:${dep}:half_open_probe`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(40);
  });

  test('HALF_OPEN with NX set sets probe key with TTL', async () => {
    await mock.hset(`circuit:${dep}`, { state: 'HALF_OPEN', failureCount: '5' });
    const allowed = await isRequestAllowed(dep);
    expect(allowed).toBe(true);
    const ttl = await mock.ttl(`circuit:${dep}:half_open_probe`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(40);
  });

  test('Subsequent HALF_OPEN request finds probe and is rejected', async () => {
    await mock.hset(`circuit:${dep}`, { state: 'HALF_OPEN', failureCount: '5' });
    expect(await isRequestAllowed(dep)).toBe(true);
    expect(await isRequestAllowed(dep)).toBe(false);
  });

  test('Stale probe key expires via TTL safety net (simulated)', async () => {
    await mock.hset(`circuit:${dep}`, { state: 'HALF_OPEN', failureCount: '5' });
    expect(await isRequestAllowed(dep)).toBe(true);
    // Simulate: probe-holder process crashed before recording success/failure.
    // Manually delete to simulate TTL expiry. (MockRedis may not auto-expire.)
    await mock.del(`circuit:${dep}:half_open_probe`);
    expect(await isRequestAllowed(dep)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/services/circuit-breaker-probe-ttl.test.ts`
Expected: FAIL — `ttl` returns `-1` (no TTL set) on the probe key.

- [ ] **Step 3: Add probe TTL constant and apply EX to both set calls**

In `src/services/circuit-breaker.ts`, near the top constants:

```typescript
import { env } from '@/config/env';
const PROBE_TTL_SECONDS = Math.ceil(env.REQUEST_TIMEOUT_MS / 1000) + 5;
```

In `IS_REQUEST_ALLOWED_SCRIPT`, both `set probeKey` calls become EX-tagged. Replace:

```typescript
const IS_REQUEST_ALLOWED_SCRIPT = `
  local key = KEYS[1]
  local probeKey = KEYS[2]
  local now = tonumber(ARGV[1])
  local resetTimeout = tonumber(ARGV[2])
  local probeTtl = tonumber(ARGV[3])

  local state = redis.call('hget', key, 'state')
  if state == false or state == 'CLOSED' then
    return 1
  end

  if state == 'OPEN' then
    local nextAttemptTime = tonumber(redis.call('hget', key, 'nextAttemptTime') or 0)
    if now >= nextAttemptTime then
      redis.call('hset', key, 'state', 'HALF_OPEN')
      redis.call('set', probeKey, '1', 'EX', probeTtl)
      return 1
    end
    return 0
  end

  if state == 'HALF_OPEN' then
    local probeSet = redis.call('set', probeKey, '1', 'NX', 'EX', probeTtl)
    if not probeSet then
      return 0
    end
    return 1
  end

  return 0
`;
```

Update the call site in `isRequestAllowed`:

```typescript
export async function isRequestAllowed(deploymentName: string): Promise<boolean> {
  const key = getCircuitKey(deploymentName);
  const probeKey = `${CIRCUIT_KEY_PREFIX}${deploymentName}:half_open_probe`;
  const result = await redis.eval(
    IS_REQUEST_ALLOWED_SCRIPT,
    2,
    key,
    probeKey,
    Date.now(),
    DEFAULT_RESET_TIMEOUT,
    PROBE_TTL_SECONDS
  );
  return result === 1;
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `bun test tests/unit/services/circuit-breaker-probe-ttl.test.ts`
Expected: PASS — all four cases green.

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/circuit-breaker.ts \
       tests/unit/services/circuit-breaker-probe-ttl.test.ts
git commit -m "fix(circuit-breaker): add TTL safety net to half-open probe key

Probe set commands now use EX <REQUEST_TIMEOUT+5s>. Crashed probes
auto-expire instead of locking out a deployment until manual cleanup.
Successful probes still explicitly DEL the key on completion."
```

---

## Task 5: Delete Orphaned `src/config/pricing.ts`

**Files:**
- Delete: `src/config/pricing.ts`
- Delete: `tests/unit/config/pricing.test.ts`
- Modify: `tests/unit/services/pricing.service.test.ts` (port unique invariants)

**Context:** `src/config/pricing.ts` is a 136-line module that provides pricing-related types and helpers. Verified: zero production imports across `src/` (only `tests/unit/config/pricing.test.ts` imports it). Production code uses `src/services/pricing.service.ts` exclusively. The orphan module is dead code that confuses contributors and represents an attack surface for stale data drift.

**Verification commands run during analysis:**
- `grep -rn "from '@/config/pricing'" src/` → empty
- `grep -rn "from '../config/pricing'" src/` → empty
- `grep -rn "config/pricing" tests/` → only the orphan's own test file

- [ ] **Step 1: Diff the two pricing modules to identify unique invariants**

Run: `diff <(grep -E '^(export|describe|test)' src/config/pricing.ts) <(grep -E '^(export|describe|test)' src/services/pricing.service.ts)`
Read both files end-to-end. List in scratchpad: any assertion in `tests/unit/config/pricing.test.ts` that does NOT have an equivalent in `tests/unit/services/pricing.service.test.ts`.

- [ ] **Step 2: Port unique assertions into the service test file**

For each unique assertion (likely: schema validation, price-positive invariant, currency unit validation), append an equivalent test to `tests/unit/services/pricing.service.test.ts`. Example shape:

```typescript
test('all configured prices are non-negative', () => {
  const { getAllPricing } = require('@/services/pricing.service');
  const all = getAllPricing();
  for (const [model, price] of Object.entries(all)) {
    expect(Number(price.input_per_1k)).toBeGreaterThanOrEqual(0);
    expect(Number(price.output_per_1k)).toBeGreaterThanOrEqual(0);
  }
});
```

> **If `tests/unit/services/pricing.service.test.ts` already covers every invariant**, skip Step 2 and proceed directly to deletion.

- [ ] **Step 3: Delete the orphan module and its test**

```bash
rm src/config/pricing.ts
rm tests/unit/config/pricing.test.ts
```

- [ ] **Step 4: Verify no production reference exists**

Run: `grep -rn "config/pricing" src/ tests/`
Expected: empty (or only matches inside the test file we may have ported).

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: ALL PASS — same count as before minus the deleted file's test count, plus any newly ported tests.

- [ ] **Step 6: Commit**

```bash
git add -A src/config/pricing.ts tests/unit/config/pricing.test.ts \
       tests/unit/services/pricing.service.test.ts
git commit -m "chore: delete orphaned src/config/pricing.ts

Production imports verified empty across src/. The module duplicated
src/services/pricing.service.ts with no consumer. Unique invariants
(if any) ported to pricing.service.test.ts."
```

---

## Acceptance Gate

The plan is shipped only when ALL hold:

- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] `bun test` — entire suite green
- [ ] `bun test --coverage` — ≥92% statement coverage maintained
- [ ] New Postgres integration test for `batchGetRequestAuditStats` exists and asserts non-zero token aggregates
- [ ] Chaos test for streaming reconcile asserts (a) WAL row exists on dual failure, (b) SSE error event emitted on dual failure, (c) `unbilled_requests_total` incremented, (d) reconciler job rebuilds `quota:*.spent` from Postgres
- [ ] Backfill script dry-run executed against staging Postgres successfully
- [ ] Manual review of `git diff` shows zero `as any`, `@ts-ignore`, or `@ts-expect-error`
- [ ] No `console.log` or `logger.error('msg', { err })` (object-second) regressions

**Honest score target: 9.5/10.** Literal 10 requires Responses API parity (tool calls, reasoning semantics, event fidelity), which is deferred to a Phase-2 sprint per Codex review #4.

---

## Execution Order

Recommended:

1. **Task 1 (CTE bug)** — silent data corruption right now; ship first, single-file change with clean test boundary.
2. **Task 2 (Postgres-as-truth + WAL)** — billing correctness; longest task; depends on nothing.
3. **Task 3 (Fallback top-up)** — depends on Task 2's metric infrastructure being in place; fine to parallelize once Task 2's `metrics.ts` edit lands.
4. **Task 4 (Probe TTL)** — independent, ~30 min.
5. **Task 5 (Delete orphan)** — independent, ~15 min.

Tasks 3, 4, 5 can be parallelized via subagent-driven-development once Tasks 1 and 2 are merged.
