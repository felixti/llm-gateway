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

function generateReservationId(): string {
  return `res_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
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
    logger.warn('Quota policy sync from Postgres failed; using Redis defaults', { userId, error });
  }
}

const CHECK_AND_RESERVE_SCRIPT = `
  local quotaKey = KEYS[1]
  local reservedKey = KEYS[2]
  local reservationKey = KEYS[3]
  local cost = tonumber(ARGV[1])
  local reservationData = ARGV[2]
  local ttl = tonumber(ARGV[3])
  local defaultBudget = tonumber(ARGV[4])
  
  local budget = tonumber(redis.call('hget', quotaKey, 'budget') or defaultBudget)
  local spent = tonumber(redis.call('hget', quotaKey, 'spent') or 0)
  local reserved = tonumber(redis.call('get', reservedKey) or 0)
  
  if spent + reserved + cost > budget then
    return {0, 'insufficient_quota'}
  end
  
  redis.call('incrbyfloat', reservedKey, cost)
  redis.call('setex', reservationKey, ttl, reservationData)
  
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
  const reservationData = `${costStr}|${userId}|${month}`;

  try {
    const result = await redis.eval(
      CHECK_AND_RESERVE_SCRIPT,
      3,
      quotaKey,
      reservedKey,
      reservationKey,
      costStr,
      reservationData,
      RESERVATION_TTL_SECONDS,
      DEFAULT_BUDGET
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
    logger.error('Quota reservation error', { error, userId });
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
    return;
  }

  const [amountStr, userId, month] = reservationData.split('|');
  const reservedKey = getReservedKey(userId, month);

  await redis.incrbyfloat(reservedKey, -Number.parseFloat(amountStr));
  await redis.del(reservationKey);
}

export async function reconcileUsage(
  reservationId: string,
  actualUsage: TokenUsage,
  model: string
): Promise<Decimal> {
  const reservationKey = getReservationKey(reservationId);

  const reservationData = await redis.get(reservationKey);
  if (!reservationData) {
    return new Decimal(0);
  }

  const [reservedAmountStr, userId, month] = reservationData.split('|');

  const actualCost = calculateCost(actualUsage, model);
  const reservedNum = Number.parseFloat(reservedAmountStr);

  const quotaKey = getQuotaKey(userId, month);
  const reservedKey = getReservedKey(userId, month);

  const pipeline = redis.pipeline();
  pipeline.hincrbyfloat(quotaKey, 'spent', actualCost.toString());
  pipeline.incrbyfloat(reservedKey, -reservedNum);
  pipeline.del(reservationKey);
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
    logger.warn('Quota read failed; falling back to defaults', { error });
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

export async function cleanupOrphanedReservations(): Promise<number> {
  const pattern = `${RESERVATION_KEY_PREFIX}*`;
  let cleaned = 0;

  try {
    let cursor = '0';
    do {
      const scanResult = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = scanResult[0];
      const keys = scanResult[1];

      for (const key of keys) {
        const ttl = await redis.ttl(key);
        if (ttl === -1) {
          const reservationId = key.replace(RESERVATION_KEY_PREFIX, '');
          await releaseReservation(reservationId);
          cleaned++;
        }
      }
    } while (cursor !== '0');
  } catch (error) {
    logger.error('Cleanup error', { error });
  }

  return cleaned;
}
