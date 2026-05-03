import { env } from '@/config/env';
import { getUserQuotaPolicyByPatSubject } from '@/db/data-access';
import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
import { incrementQuotaHydrationFailures } from '@/observability/metrics';
import { Decimal } from 'decimal.js';
import { type TokenUsage, calculateCost } from './pricing.service';

export interface QuotaReservation {
  allowed: boolean;
  reservationId?: string;
  estimatedCost?: Decimal;
  reason?: string;
}

export interface QuotaStatus {
  monthly_budget_usd: number;
  spent_usd: number;
  reserved_usd: number;
  remaining_usd: number;
  reset_date: string;
  hard_limit: boolean;
}

const QUOTA_KEY_PREFIX = 'quota:';
const RESERVED_KEY_PREFIX = 'reserved:';
const RESERVATION_KEY_PREFIX = 'reservation:';
const RESERVATION_HASH_PREFIX = 'reservations_meta:';
const IDEMPOTENCY_RELEASE_PREFIX = 'released:';
const IDEMPOTENCY_RECONCILE_PREFIX = 'reconciled:';
const IDEMPOTENCY_CLEANUP_PREFIX = 'cleanup:';

const MICRODOLLAR_SCALE = 1_000_000;
const RESERVATION_TTL_SECONDS = env.QUOTA_RESERVATION_TTL_SECONDS;
const DEFAULT_BUDGET_USD = 50;
const DEFAULT_BUDGET_MICRO = toMicrodollars(new Decimal(DEFAULT_BUDGET_USD));

const DB_POLICY_SYNC_INTERVAL_MS = 60_000;

function toMicrodollars(d: Decimal): string {
  return d.mul(MICRODOLLAR_SCALE).round().toString();
}

function fromMicrodollars(s: string): Decimal {
  return new Decimal(s).div(MICRODOLLAR_SCALE);
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getResetDate(): string {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.toISOString();
}

function getQuotaKey(userId: string, month: string): string {
  return `${QUOTA_KEY_PREFIX}${userId}:${month}`;
}

function getReservedKey(userId: string, month: string): string {
  return `${RESERVED_KEY_PREFIX}${userId}:${month}`;
}

function getReservationKey(reservationId: string): string {
  return `${RESERVATION_KEY_PREFIX}${reservationId}`;
}

function getReservationHashKey(userId: string, month: string): string {
  return `${RESERVATION_HASH_PREFIX}${userId}:${month}`;
}

function generateReservationId(): string {
  return `res_${crypto.randomUUID()}`;
}

function shouldSyncQuotaFromPostgres(): boolean {
  if (process.env.NODE_ENV === 'test' && process.env.QUOTA_PG_SYNC_IN_TESTS !== 'true') {
    return false;
  }
  return true;
}

export async function syncQuotaPolicyFromPostgres(userId: string, month: string): Promise<void> {
  if (!shouldSyncQuotaFromPostgres()) {
    return;
  }

  const quotaKey = getQuotaKey(userId, month);

  try {
    const syncedAt = await redis.hget(quotaKey, 'db_synced_at');
    if (syncedAt && Date.now() - Number(syncedAt) < DB_POLICY_SYNC_INTERVAL_MS) {
      return;
    }

    const policy = await getUserQuotaPolicyByPatSubject(userId);
    const budgetDollars = new Decimal(policy?.monthly_budget_usd ?? DEFAULT_BUDGET_USD);
    const budgetMicro = toMicrodollars(budgetDollars);
    const hardLimit = policy?.hard_limit !== false;

    await redis.hset(quotaKey, {
      budget: budgetMicro,
      hard_limit: hardLimit ? '1' : '0',
      db_synced_at: String(Date.now()),
    });
  } catch (error) {
    incrementQuotaHydrationFailures();
    logger.warn({ userId, error }, 'Quota policy sync from Postgres failed; using Redis defaults');
  }
}

const CHECK_AND_RESERVE_SCRIPT = `
  local quotaKey = KEYS[1]
  local reservedKey = KEYS[2]
  local reservationKey = KEYS[3]
  local hashKey = KEYS[4]
  local cost = tonumber(ARGV[1])
  local reservationData = ARGV[2]
  local defaultBudget = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[4])
  local reservationId = ARGV[5]

  local budget = tonumber(redis.call('hget', quotaKey, 'budget') or defaultBudget)
  local spent = tonumber(redis.call('hget', quotaKey, 'spent') or 0)
  local reserved = tonumber(redis.call('get', reservedKey) or 0)

  if spent + reserved + cost > budget then
    return {0, 'insufficient_quota'}
  end

  redis.call('incrby', reservedKey, math.floor(cost))
  redis.call('set', reservationKey, reservationData, 'EX', ttl)
  redis.call('hset', hashKey, reservationId, reservationData)

  return {1, 'ok'}
`;

const RELEASE_RESERVATION_SCRIPT = `
  local idempotencyKey = KEYS[1]
  local reservationKey = KEYS[2]
  local reservationId = ARGV[1]

  if redis.call('exists', idempotencyKey) == 1 then
    return {0, 'already_released'}
  end

  local data = redis.call('get', reservationKey)
  if not data then
    redis.call('set', idempotencyKey, '0', 'EX', 86400)
    return {0, 'not_found'}
  end

  local amountMicro, userId, month
  local idx = 0
  for part in string.gmatch(data, '[^|]+') do
    if idx == 0 then amountMicro = part
    elseif idx == 1 then userId = part
    elseif idx == 2 then month = part
    end
    idx = idx + 1
  end

  if not amountMicro or not userId or not month then
    redis.call('set', idempotencyKey, '0', 'EX', 86400)
    return {0, 'parse_error'}
  end

  local reservedKey = 'reserved:' .. userId .. ':' .. month
  local hashKey = 'reservations_meta:' .. userId .. ':' .. month

  redis.call('incrby', reservedKey, -tonumber(amountMicro))
  redis.call('del', reservationKey)
  redis.call('hdel', hashKey, reservationId)
  redis.call('set', idempotencyKey, amountMicro, 'EX', 86400)

  return {1, 'ok', amountMicro}
`;

const RECONCILE_USAGE_SCRIPT = `
  local idempotencyKey = KEYS[1]
  local reservationKey = KEYS[2]
  local reservationId = ARGV[1]
  local costMicro = ARGV[2]

  if redis.call('exists', idempotencyKey) == 1 then
    return {0, 'already_reconciled'}
  end

  local data = redis.call('get', reservationKey)
  if not data then
    redis.call('set', idempotencyKey, costMicro, 'EX', 86400)
    return {0, 'not_found'}
  end

  local reservedAmountMicro, userId, month
  local idx = 0
  for part in string.gmatch(data, '[^|]+') do
    if idx == 0 then reservedAmountMicro = part
    elseif idx == 1 then userId = part
    elseif idx == 2 then month = part
    end
    idx = idx + 1
  end

  if not reservedAmountMicro or not userId or not month then
    redis.call('set', idempotencyKey, costMicro, 'EX', 86400)
    return {0, 'parse_error'}
  end

  local quotaKey = 'quota:' .. userId .. ':' .. month
  local reservedKey = 'reserved:' .. userId .. ':' .. month
  local hashKey = 'reservations_meta:' .. userId .. ':' .. month

  redis.call('hincrby', quotaKey, 'spent', tonumber(costMicro))
  redis.call('incrby', reservedKey, -tonumber(reservedAmountMicro))
  redis.call('del', reservationKey)
  redis.call('hdel', hashKey, reservationId)
  redis.call('set', idempotencyKey, costMicro, 'EX', 86400)

  return {1, 'ok', costMicro, reservedAmountMicro}
`;

const CLEANUP_ORPHAN_SCRIPT = `
  -- orphan_cleanup
  local hashKey = KEYS[1]
  local nowMs = tonumber(ARGV[1])
  local ttlMs = tonumber(ARGV[2])

  local fields = redis.call('hgetall', hashKey)
  local cleaned = 0

  for i = 1, #fields, 2 do
    local reservationId = fields[i]
    local data = fields[i + 1]

    local amountMicro, userId, month, createdAtStr
    local idx = 0
    for part in string.gmatch(data, '[^|]+') do
      if idx == 0 then amountMicro = part
      elseif idx == 1 then userId = part
      elseif idx == 2 then month = part
      elseif idx == 3 then createdAtStr = part
      end
      idx = idx + 1
    end

    if amountMicro and userId and month and createdAtStr then
      local createdAt = tonumber(createdAtStr)
      if createdAt and (nowMs - createdAt) > ttlMs then
        local reservationKey = 'reservation:' .. reservationId
        if redis.call('exists', reservationKey) == 0 then
          local idemKey = '${IDEMPOTENCY_CLEANUP_PREFIX}' .. reservationId
          if redis.call('exists', idemKey) == 0 then
            local reservedKey = 'reserved:' .. userId .. ':' .. month
            redis.call('incrby', reservedKey, -tonumber(amountMicro))
            redis.call('hdel', hashKey, reservationId)
            redis.call('set', idemKey, '1', 'EX', 86400)
            cleaned = cleaned + 1
          end
        end
      end
    end
  end

  return cleaned
`;

export async function checkAndReserve(
  userId: string,
  estimatedCost: Decimal
): Promise<QuotaReservation> {
  const month = getCurrentMonth();
  await syncQuotaPolicyFromPostgres(userId, month);

  const reservationId = generateReservationId();
  const costMicro = toMicrodollars(estimatedCost);

  const quotaKey = getQuotaKey(userId, month);
  const reservedKey = getReservedKey(userId, month);
  const reservationKey = getReservationKey(reservationId);
  const hashKey = getReservationHashKey(userId, month);
  const reservationData = `${costMicro}|${userId}|${month}|${Date.now()}`;

  try {
    const result = await redis.eval(
      CHECK_AND_RESERVE_SCRIPT,
      4,
      quotaKey,
      reservedKey,
      reservationKey,
      hashKey,
      costMicro,
      reservationData,
      DEFAULT_BUDGET_MICRO,
      RESERVATION_TTL_SECONDS,
      reservationId
    );

    if (Array.isArray(result) && result[0] === 0) {
      return {
        allowed: false,
        reason: 'Insufficient quota',
      };
    }

    return {
      allowed: true,
      reservationId,
      estimatedCost,
    };
  } catch (error) {
    logger.error({ error, userId }, 'Quota reservation error');
    return {
      allowed: false,
      reason: 'Reservation failed',
    };
  }
}

export async function releaseReservation(reservationId: string): Promise<void> {
  const idempotencyKey = `${IDEMPOTENCY_RELEASE_PREFIX}${reservationId}`;
  const reservationKey = getReservationKey(reservationId);

  try {
    const result = (await redis.eval(
      RELEASE_RESERVATION_SCRIPT,
      2,
      idempotencyKey,
      reservationKey,
      reservationId
    )) as (string | number)[];

    if (Array.isArray(result) && result[1] === 'not_found') {
      const nullData = await tryRecoverFromHash(reservationId);
      if (nullData) {
        const reservedKey = getReservedKey(nullData.userId, nullData.month);
        const hashKey = getReservationHashKey(nullData.userId, nullData.month);

        await redis.incrby(reservedKey, -Number(nullData.amountMicro));
        await redis.hdel(hashKey, reservationId);

        logger.warn(
          { reservationId, userId: nullData.userId, month: nullData.month },
          'Released expired reservation via hash fallback'
        );
      }
    }
  } catch (error) {
    logger.error({ error, reservationId }, 'Release reservation error');
  }
}

export async function recordUsageOnly(
  userId: string,
  actualUsage: TokenUsage,
  model: string
): Promise<Decimal> {
  const actualCost = calculateCost(actualUsage, model);
  const costMicro = toMicrodollars(actualCost);
  const month = getCurrentMonth();
  const quotaKey = getQuotaKey(userId, month);

  await redis.hincrby(quotaKey, 'spent', Number(costMicro));

  return actualCost;
}

export async function reconcileUsage(
  reservationId: string,
  actualUsage: TokenUsage,
  model: string
): Promise<Decimal> {
  const actualCost = calculateCost(actualUsage, model);
  const costMicro = toMicrodollars(actualCost);
  const idempotencyKey = `${IDEMPOTENCY_RECONCILE_PREFIX}${reservationId}`;
  const reservationKey = getReservationKey(reservationId);

  try {
    const result = (await redis.eval(
      RECONCILE_USAGE_SCRIPT,
      2,
      idempotencyKey,
      reservationKey,
      reservationId,
      costMicro
    )) as (string | number)[];

    if (Array.isArray(result) && result[0] === 1) {
      return actualCost;
    }

    if (Array.isArray(result) && result[1] === 'already_reconciled') {
      return new Decimal(0);
    }

    if (Array.isArray(result) && result[1] === 'not_found') {
      const nullData = await tryRecoverFromHash(reservationId);
      if (nullData) {
        const quotaKey = getQuotaKey(nullData.userId, nullData.month);
        const reservedKey = getReservedKey(nullData.userId, nullData.month);
        const hashKey = getReservationHashKey(nullData.userId, nullData.month);

        const pipeline = redis.pipeline();
        pipeline.hincrbyfloat(quotaKey, 'spent', costMicro);
        pipeline.incrbyfloat(reservedKey, `-${nullData.amountMicro}`);
        pipeline.hdel(hashKey, reservationId);
        await pipeline.exec();

        logger.warn(
          { reservationId, userId: nullData.userId, month: nullData.month },
          'Reconciled expired reservation via hash fallback'
        );
        return actualCost;
      }
      return new Decimal(0);
    }

    return new Decimal(0);
  } catch (error) {
    logger.error({ error, reservationId }, 'Reconcile usage error');
    return new Decimal(0);
  }
}

function parseHardLimitFlag(value: string | null): boolean {
  if (value === '0' || value === 'false') {
    return false;
  }
  return true;
}

async function safeReadOrNull(op: () => Promise<string | null>): Promise<string | null> {
  try {
    return await op();
  } catch (error) {
    logger.warn({ error }, 'Quota read failed; falling back to defaults');
    return null;
  }
}

export async function getQuotaStatus(userId: string): Promise<QuotaStatus> {
  const month = getCurrentMonth();
  await syncQuotaPolicyFromPostgres(userId, month);

  const quotaKey = getQuotaKey(userId, month);
  const reservedKey = getReservedKey(userId, month);

  const [budget, spent, reserved, hardRaw] = await Promise.all([
    safeReadOrNull(() => redis.hget(quotaKey, 'budget')),
    safeReadOrNull(() => redis.hget(quotaKey, 'spent')),
    safeReadOrNull(() => redis.get(reservedKey)),
    safeReadOrNull(() => redis.hget(quotaKey, 'hard_limit')),
  ]);

  const budgetDecimal = fromMicrodollars(budget || DEFAULT_BUDGET_MICRO);
  const spentDecimal = fromMicrodollars(spent || '0');
  const reservedDecimal = fromMicrodollars(reserved || '0');
  const remaining = budgetDecimal.minus(spentDecimal).minus(reservedDecimal);

  return {
    monthly_budget_usd: budgetDecimal.toNumber(),
    spent_usd: spentDecimal.toNumber(),
    reserved_usd: reservedDecimal.toNumber(),
    remaining_usd: Math.max(0, remaining.toNumber()),
    reset_date: getResetDate(),
    hard_limit: parseHardLimitFlag(hardRaw),
  };
}

export async function setMonthlyBudget(
  userId: string,
  budgetUsd: number,
  month?: string
): Promise<void> {
  const targetMonth = month || getCurrentMonth();
  const quotaKey = getQuotaKey(userId, targetMonth);
  const budgetMicro = toMicrodollars(new Decimal(budgetUsd));

  await redis.hset(quotaKey, {
    budget: budgetMicro,
    spent: '0',
    reset_date: getResetDate(),
    db_synced_at: String(Date.now()),
  });
}

const MAX_SCAN_ITERATIONS = 100;

async function tryRecoverFromHash(
  reservationId: string
): Promise<{ userId: string; month: string; amountMicro: string } | null> {
  try {
    let cursor = '0';
    let iterations = 0;
    do {
      iterations++;
      if (iterations > MAX_SCAN_ITERATIONS) {
        logger.warn(
          { reservationId, iterations },
          'Max SCAN iterations exceeded in tryRecoverFromHash'
        );
        break;
      }
      const scanResult = await redis.scan(
        cursor,
        'MATCH',
        `${RESERVATION_HASH_PREFIX}*`,
        'COUNT',
        100
      );
      cursor = scanResult[0];
      const hashKeys = scanResult[1];

      for (const hashKey of hashKeys) {
        const data = await redis.hget(hashKey, reservationId);
        if (data) {
          const parts = data.split('|');
          if (parts.length >= 3) {
            const amountMicro = parts[0];
            const userId = parts[1];
            const month = parts[2] || getCurrentMonth();
            return { userId, month, amountMicro };
          }
        }
      }
    } while (cursor !== '0');
  } catch (error) {
    logger.warn({ error, reservationId }, 'Failed to recover reservation from hash');
  }
  return null;
}

export async function cleanupOrphanedReservations(): Promise<number> {
  const nowMs = Date.now();
  const ttlMs = RESERVATION_TTL_SECONDS * 1000;
  let totalCleaned = 0;

  try {
    let cursor = '0';
    do {
      const scanResult = await redis.scan(
        cursor,
        'MATCH',
        `${RESERVATION_HASH_PREFIX}*`,
        'COUNT',
        100
      );
      cursor = scanResult[0];
      const hashKeys = scanResult[1];

      for (const hashKey of hashKeys) {
        const cleaned = (await redis.eval(
          CLEANUP_ORPHAN_SCRIPT,
          1,
          hashKey,
          String(nowMs),
          String(ttlMs)
        )) as number;
        totalCleaned += cleaned;
      }
    } while (cursor !== '0');
  } catch (error) {
    logger.error({ error }, 'Cleanup error');
  }

  return totalCleaned;
}
