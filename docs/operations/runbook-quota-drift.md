# Runbook: Quota drift between Postgres and Redis

## The model

- **Postgres `users` is authoritative** for `monthly_budget_usd` and `hard_limit`.
- **Redis is the fast path**: `quota:{userId}:{YYYY-MM}` hash holds `budget`, `hard_limit`, `spent`, and `db_synced_at`.
- The gateway syncs Postgres → Redis on every quota check, gated by `db_synced_at` so we re-read at most once every 60 s per user-month.
- `reserved` lives in `reserved:{userId}:{YYYY-MM}` and is mutated by atomic Lua scripts.
- Upstream failures, missing usage, and client stream aborts release the reservation immediately; successful responses with usage reconcile the reservation to actual spend.
- Failures to read Postgres increment the metric `quota_hydration_failures_total` and fall back to Redis defaults (`50` USD, `hard_limit=true`) so the gateway stays available.

---

## Symptoms of drift

| Symptom | Likely cause |
|---|---|
| User updated in admin tool but `GET /quota` shows old budget | Sync interval not yet elapsed (≤ 60 s) **or** `users.pat_subject` doesn't match the PAT `userId` |
| `quota_hydration_failures_total` rising | Postgres connectivity / auth issue |
| `hard_limit` ignored (soft behavior) when Postgres says `true` | `QUOTA_SOFT_LIMIT_ENABLED=true` overrides per-user policy globally |
| 429 `quota_exceeded` for users with budget remaining | `reserved_usd` stuck high (orphaned reservations) |

If `reserved_usd` rises during upstream incidents, compare it with upstream 5xx/429 logs. Non-OK upstream responses should release reservations immediately; only process crashes or Redis failures should leave reservations waiting for TTL cleanup.

---

## Quick diagnostics

```bash
# 1. What does the gateway think the user has?
curl -s -H "Authorization: Bearer $USER_PAT" "$GATEWAY/quota" | jq

# 2. What does Postgres say?
psql "$DATABASE_URL" -c \
  "SELECT id, pat_subject, monthly_budget_usd, hard_limit FROM users WHERE pat_subject = '$USER_ID' OR id::text = '$USER_ID';"

# 3. What does Redis hold?
MONTH=$(date -u +%Y-%m)
redis-cli HGETALL "quota:$USER_ID:$MONTH"
redis-cli GET    "reserved:$USER_ID:$MONTH"
```

If Postgres and `GET /quota` disagree, jump to **Force a re-sync** below.

---

## Force a re-sync

The simplest way is to delete `db_synced_at` so the next request re-reads Postgres:

```bash
MONTH=$(date -u +%Y-%m)
redis-cli HDEL "quota:$USER_ID:$MONTH" db_synced_at
```

Then call `GET /quota` (or any LLM route) as that user — the response should now reflect Postgres.

For all users at once (use sparingly):

```bash
redis-cli --scan --pattern "quota:*" | while read key; do
  redis-cli HDEL "$key" db_synced_at >/dev/null
done
```

---

## Reset a user's spent counter (e.g., billing dispute)

```bash
MONTH=$(date -u +%Y-%m)
redis-cli HSET "quota:$USER_ID:$MONTH" spent 0
```

Audit log the action manually (Postgres `request_audit` is append-only and reflects historic charges).

---

## Recover from orphaned reservations

Reservations carry a TTL (`QUOTA_RESERVATION_TTL_SECONDS`, default 300 s). If the scheduler is up they are cleaned automatically by `cleanupOrphanedReservations`. If `reserved_usd` is stuck high:

```bash
# Inspect
redis-cli --scan --pattern "reservation:*" | head

# Zero a specific user-month
MONTH=$(date -u +%Y-%m)
redis-cli SET "reserved:$USER_ID:$MONTH" 0
```

Verify `GET /quota` reports `reserved_usd: 0`.

---

## Postgres unavailable

The gateway degrades gracefully:

- New users default to `monthly_budget_usd=50`, `hard_limit=true`.
- `quota_hydration_failures_total` increases — alert on sustained increase.
- Existing Redis hashes keep their last-synced values until the next successful sync.

To reduce surprise on long Postgres outages, either:

1. Pre-warm Redis with the latest budgets via a one-off script during the outage window, or
2. Set `QUOTA_SOFT_LIMIT_ENABLED=true` to keep the gateway from rejecting requests while the policy is stale.

---

## Mapping: PAT subject vs `users.pat_subject`

The auth middleware sets `c.set('userId', token.userId)` where `token.userId` is parsed from `lg_{userId}_…`. The DAO query is:

```sql
SELECT monthly_budget_usd, hard_limit
FROM users
WHERE pat_subject = $1 OR id::text = $1
LIMIT 1;
```

So either:

- Issue PATs with `userId = users.id::text` (UUID), or
- Set `users.pat_subject = '<whatever userId you embedded>'` (see migration `002_pat_subject.sql`).

If neither matches, `getUserQuotaPolicyByPatSubject` returns `null` and Redis falls back to the default budget — that user effectively has the default 50 USD/month.

---

## Usage-history backfill (CTE bug — pre-2026-05-04 archives)

`usage_history` rows archived before commit `<fixing-CTE-bug>` have all-zero
`total_tokens_*` and `total_requests` because `batchGetRequestAuditStats` built
the CTE with literal integers (`(2, 3, 4)`) instead of `($2, $3, $4)`. Postgres
either rejected the query (`42P18`) or — depending on cast inference — joined
zero rows from `make_date(2, 3, 1)` (year 2 AD, March, day 1). `total_cost_usd`
was always correct because it is read directly from Redis `quota:*.spent`.

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
      AND r.created_at < make_date(
        CAST(SUBSTRING(usage_history.month FROM 1 FOR 4) AS int),
        CAST(SUBSTRING(usage_history.month FROM 6 FOR 2) AS int),
        1
      ) + INTERVAL '1 month'
  );
```

### Fix

```bash
bun scripts/backfill-usage-history.ts            # dry-run — log drift, no writes
bun scripts/backfill-usage-history.ts --apply    # apply UPDATE statements
```

The script is idempotent: re-runs are safe and update only rows that still
drift from `request_audit` ground truth. `total_cost_usd` is preserved.
