import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
import { Decimal } from 'decimal.js';
import { type TokenUsage, calculateCost } from './pricing.service';
import {
  DEFAULT_BUDGET_MICRO,
  IDEMPOTENCY_RECONCILE_PREFIX,
  IDEMPOTENCY_RELEASE_PREFIX,
  MAX_SCAN_ITERATIONS,
  RESERVATION_HASH_PREFIX,
  RESERVATION_TTL_SECONDS,
  getIdempotencyTtlSeconds,
} from './quota/constants';
import {
  generateReservationId,
  getCurrentMonth,
  getQuotaKey,
  getReservationHashKey,
  getReservationKey,
  getReservedKey,
  getResetDate,
} from './quota/keys';
import { fromMicrodollars, toMicrodollars } from './quota/money';
import { syncQuotaPolicyFromPostgres } from './quota/policy';
import {
  CHECK_AND_RESERVE_SCRIPT,
  CLEANUP_ORPHAN_SCRIPT,
  RECONCILE_USAGE_SCRIPT,
  RELEASE_RESERVATION_SCRIPT,
} from './quota/scripts';

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

export { syncQuotaPolicyFromPostgres };

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
      reservationId,
      getIdempotencyTtlSeconds()
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
      costMicro,
      getIdempotencyTtlSeconds()
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
          String(ttlMs),
          String(getIdempotencyTtlSeconds())
        )) as number;
        totalCleaned += cleaned;
      }
    } while (cursor !== '0');
  } catch (error) {
    logger.error({ error }, 'Cleanup error');
  }

  return totalCleaned;
}
