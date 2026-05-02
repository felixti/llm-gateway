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
  /** Enforced budget policy: false = soft limit (warn), true = hard (429 when over) */
  hard_limit: boolean;
}

const QUOTA_KEY_PREFIX = 'quota:';
const RESERVED_KEY_PREFIX = 'reserved:';
const RESERVATION_KEY_PREFIX = 'reservation:';
const RESERVATION_HASH_PREFIX = 'reservations_meta:';

const RESERVATION_TTL_SECONDS = env.QUOTA_RESERVATION_TTL_SECONDS;
const DEFAULT_BUDGET = 50;

/** How often to re-read Postgres policy into Redis (per user/month key) */
const DB_POLICY_SYNC_INTERVAL_MS = 60_000;

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

/** In tests, Postgres sync is off by default to avoid hanging on DB I/O; CI sets QUOTA_PG_SYNC_IN_TESTS=true */
function shouldSyncQuotaFromPostgres(): boolean {
  if (process.env.NODE_ENV === 'test' && process.env.QUOTA_PG_SYNC_IN_TESTS !== 'true') {
    return false;
  }
  return true;
}

/**
 * Postgres is authoritative for monthly budget + hard_limit. Redis holds live spent/reserved.
 * Skips sync if recently synced (see DB_POLICY_SYNC_INTERVAL_MS).
 */
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
    const budget = policy?.monthly_budget_usd ?? String(DEFAULT_BUDGET);
    const hardLimit = policy?.hard_limit !== false;

    await redis.hset(quotaKey, {
      budget,
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

  redis.call('incrbyfloat', reservedKey, cost)
  redis.call('set', reservationKey, reservationData, 'EX', ttl)
  redis.call('hset', hashKey, reservationId, reservationData)

  return {1, 'ok'}
`;

export async function checkAndReserve(
  userId: string,
  estimatedCost: Decimal
): Promise<QuotaReservation> {
  const month = getCurrentMonth();
  await syncQuotaPolicyFromPostgres(userId, month);

  const reservationId = generateReservationId();
  const costStr = estimatedCost.toString();

  const quotaKey = getQuotaKey(userId, month);
  const reservedKey = getReservedKey(userId, month);
  const reservationKey = getReservationKey(reservationId);
  const hashKey = getReservationHashKey(userId, month);
  const reservationData = `${costStr}|${userId}|${month}|${Date.now()}`;

  try {
    const result = await redis.eval(
      CHECK_AND_RESERVE_SCRIPT,
      4,
      quotaKey,
      reservedKey,
      reservationKey,
      hashKey,
      costStr,
      reservationData,
      DEFAULT_BUDGET,
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
  const reservationKey = getReservationKey(reservationId);

  const reservationData = await redis.get(reservationKey);
  if (!reservationData) {
    const nullData = await tryRecoverFromHash(reservationId);
    if (nullData) {
      logger.warn(
        { reservationId, userId: nullData.userId, month: nullData.month },
        'Released expired reservation via hash fallback'
      );
    }
    return;
  }

  const parts = reservationData.split('|');
  const amountStr = parts[0];
  const userId = parts[1];
  const month = parts[2];
  const reservedKey = getReservedKey(userId, month);
  const hashKey = getReservationHashKey(userId, month);

  await redis.incrbyfloat(reservedKey, -Number.parseFloat(amountStr));
  await redis.del(reservationKey);
  await redis.hdel(hashKey, reservationId);
}

/**
 * Record actual usage for soft-quota requests that bypassed reservation.
 * Directly increments the user's spent quota without requiring a reservation.
 * Used when QUOTA_SOFT_LIMIT_ENABLED=true and user is over budget but still allowed.
 */
export async function recordUsageOnly(
  userId: string,
  actualUsage: TokenUsage,
  model: string
): Promise<Decimal> {
  const actualCost = calculateCost(actualUsage, model);
  const month = getCurrentMonth();
  const quotaKey = getQuotaKey(userId, month);

  await redis.hincrbyfloat(quotaKey, 'spent', actualCost.toString());

  return actualCost;
}

export async function reconcileUsage(
  reservationId: string,
  actualUsage: TokenUsage,
  model: string
): Promise<Decimal> {
  const reservationKey = getReservationKey(reservationId);

  const reservationData = await redis.get(reservationKey);
  if (!reservationData) {
    const nullData = await tryRecoverFromHash(reservationId);
    if (nullData) {
      const actualCost = calculateCost(actualUsage, model);
      const quotaKey = getQuotaKey(nullData.userId, nullData.month);
      const reservedKey = getReservedKey(nullData.userId, nullData.month);
      const hashKey = getReservationHashKey(nullData.userId, nullData.month);

      const pipeline = redis.pipeline();
      pipeline.hincrbyfloat(quotaKey, 'spent', actualCost.toString());
      pipeline.incrbyfloat(reservedKey, -nullData.amount);
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

  const parts = reservationData.split('|');
  const reservedAmountStr = parts[0];
  const userId = parts[1];
  const month = parts[2];

  const actualCost = calculateCost(actualUsage, model);
  const reservedNum = Number.parseFloat(reservedAmountStr);

  const quotaKey = getQuotaKey(userId, month);
  const reservedKey = getReservedKey(userId, month);
  const hashKey = getReservationHashKey(userId, month);

  const pipeline = redis.pipeline();
  pipeline.hincrbyfloat(quotaKey, 'spent', actualCost.toString());
  pipeline.incrbyfloat(reservedKey, -reservedNum);
  pipeline.del(reservationKey);
  pipeline.hdel(hashKey, reservationId);
  await pipeline.exec();

  return actualCost;
}

function parseHardLimitFlag(value: string | null): boolean {
  if (value === '0' || value === 'false') {
    return false;
  }
  return true;
}

/**
 * Safely read a Redis value, returning `null` if the call rejects. Used by
 * `getQuotaStatus` to degrade to defaults instead of erroring when Redis
 * hiccups — callers can still render a 200 with conservative numbers rather
 * than leaking a 500 for a transient read failure.
 */
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

  const budgetDecimal = new Decimal(budget || DEFAULT_BUDGET);
  const spentDecimal = new Decimal(spent || '0');
  const reservedDecimal = new Decimal(reserved || '0');
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

  await redis.hset(quotaKey, {
    budget: budgetUsd.toString(),
    spent: '0',
    reset_date: getResetDate(),
    db_synced_at: String(Date.now()),
  });
}

async function tryRecoverFromHash(
  reservationId: string
): Promise<{ userId: string; month: string; amount: number } | null> {
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
        const data = await redis.hget(hashKey, reservationId);
        if (data) {
          const parts = data.split('|');
          if (parts.length >= 2) {
            const amount = Number.parseFloat(parts[0]);
            const userId = parts[1];
            const month = parts[2] || getCurrentMonth();
            return { userId, month, amount };
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
  let cleaned = 0;

  const nowMs = Date.now();
  const ttlMs = RESERVATION_TTL_SECONDS * 1000;

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
        const fields = await redis.hgetall(hashKey);
        for (const [reservationId, data] of Object.entries(fields)) {
          const parts = data.split('|');
          if (parts.length < 3) continue;
          const amountStr = parts[0];
          const userId = parts[1];
          const month = parts[2];
          const createdAt = parts.length >= 4 ? Number(parts[3]) : 0;

          if (!createdAt || nowMs - createdAt <= ttlMs) continue;

          const exists = await redis.exists(getReservationKey(reservationId));
          if (exists > 0) continue;

          const reservedKey = getReservedKey(userId, month);
          const amount = Number.parseFloat(amountStr);
          if (!Number.isNaN(amount)) {
            await redis.incrbyfloat(reservedKey, -amount);
            cleaned++;
          }
          await redis.hdel(hashKey, reservationId);
        }
      }
    } while (cursor !== '0');
  } catch (error) {
    logger.error({ error }, 'Cleanup error');
  }

  return cleaned;
}
