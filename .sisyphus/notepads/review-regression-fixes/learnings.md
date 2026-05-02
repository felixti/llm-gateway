## [2026-05-02T15:21:00Z] Task 2-7 Research Complete

### MockRedis (tests/integration/helpers/mock-redis.ts)
- Has `store` (Map<string, string>) and `hashes` (Map<string, Map<string, string>>)
- Supports: get, set, setex, eval, hget, hgetall, hset, pipeline, incrbyfloat, del, ping, scan, ttl
- `scan` returns `['0', []]` always! Need to extend for cleanup tests.
- `eval` has hardcoded string matching for different Lua scripts:
  - `'monthly_budget' || 'reserved'` → returns [1, 0] (quota check-and-reserve)
  - `'threshold'` → circuit breaker record failure
  - `'nextAttemptTime' && !'failureCount'` → circuit breaker check
- **Missing**: `exists()` method
- **Problem**: The quota `eval` catch-all `if (script.includes('monthly_budget') || script.includes('reserved'))` returns `[1, 0]` always — won't work for new hash-based script. Need to update MockRedis.eval.

### quota.service.ts Key Structures
- `RESERVATION_KEY_PREFIX = 'reservation:'`
- `getReservationKey(id)` → `reservation:{id}`
- `getReservedKey(userId, month)` → `reserved:{userId}:{month}`
- Reservation data format: `{cost}|{userId}|{month}|{createdAt}`
- `RESERVATION_TTL_SECONDS` from env, default 300

### CHECK_AND_RESERVE_SCRIPT (lines 80-98)
```lua
local quotaKey = KEYS[1]
local reservedKey = KEYS[2]
local reservationKey = KEYS[3]
local cost = tonumber(ARGV[1])
local reservationData = ARGV[2]
local defaultBudget = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local budget = tonumber(redis.call('hget', quotaKey, 'budget') or defaultBudget)
local spent = tonumber(redis.call('hget', quotaKey, 'spent') or 0)
local reserved = tonumber(redis.call('get', reservedKey) or 0)

if spent + reserved + cost > budget then
  return {0, 'insufficient_quota'}
end

redis.call('incrbyfloat', reservedKey, cost)
redis.call('set', reservationKey, reservationData, 'EX', ttl)

return {1, 'ok'}
```

### releaseReservation (lines 133-150)
- Gets reservation key, reads data with redis.get
- If null: returns early (BUG — Gap 3)
- Parses: cost|userId|month|createdAt
- Decrements reserved:{userId}:{month}
- Deletes reservation key

### reconcileUsage (lines 163-192)
- Gets reservation key, reads data with redis.get
- If null: returns new Decimal(0) (BUG — Gap 3)
- Calculates actual cost from usage
- Pipeline: hincrbyfloat quota spent, incrbyfloat reserved -reservedAmount, del reservationKey

### cleanupOrphanedReservations (lines 297-330)
- SCAN pattern `reservation:*`
- For each key found, runs CLEANUP_ORPHAN_SCRIPT Lua
- Lua parses data format, checks if (now - createdAt) > ttlMs
- If orphan: decrements reserved, deletes key
- **BUG**: SCAN only finds keys that still exist. If Redis TTL expired them, they're gone.

### health.service.ts
- `buildChatCompletionsHealthBody` uses `deployment.name` — BUG for Foundry
- `buildAnthropicHealthBody` uses `deployment.name` — OK (Claude name === azureModelName)
- `FOUNDRY_FAMILIES` already imported at line 5

### health.routes.ts
- `/ready` at line 54-86
- `checks.deployments = Array.from(cachedHealth.values()).some((h) => h.healthy)`
- When cache is empty (probes disabled): always false → 503

### metrics.ts
- Has `incrementCounter(name, value=1)` helper
- Has `inMemoryCounters` record
- Need to add: `quota_orphan_cleaned_total`, `quota_reservation_null_total`
- Pattern: `incrementCounter('quota_orphan_cleaned_total')`

### deployments.ts
- `FOUNDRY_FAMILIES = ['kimi', 'glm', 'minimax']`
- Kimi: name='kimi-k2.5', azureModelName='FW-Kimi-K2.5'
- GLM: name='glm-5', azureModelName='FW-GLM-5'
- MiniMax: name='minimax-m2.5', azureModelName='FW-MiniMax-M2.5'
- GPT: name === azureModelName (no difference)

### env.ts — HEALTH_CHECK_DEPLOYMENTS_ENABLED
- Defined in env.ts, defaults to true
- Used in health.service.ts startHealthChecks() for early return
