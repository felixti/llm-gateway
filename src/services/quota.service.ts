import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
import { incrementQuotaOrphanCleaned } from '@/observability/metrics';
import { type Result, err, ok } from '@/utils/result';
import { Decimal } from 'decimal.js';
import { type TokenUsage, calculateCost } from './pricing.service';
import {
  DEFAULT_BUDGET_MICRO,
  IDEMPOTENCY_CLEANUP_PREFIX,
  IDEMPOTENCY_RECONCILE_PREFIX,
  IDEMPOTENCY_RECORD_ONLY_PREFIX,
  IDEMPOTENCY_RELEASE_PREFIX,
  MAX_SCAN_ITERATIONS,
  QUOTA_KEY_PREFIX,
  RESERVATION_HASH_PREFIX,
  RESERVATION_KEY_PREFIX,
  RESERVATION_TTL_SECONDS,
  RESERVED_KEY_PREFIX,
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
  TOP_UP_RESERVATION_SCRIPT,
} from './quota/scripts';

export interface QuotaReservation {
  allowed: boolean;
  reservationId?: string;
  estimatedCost?: Decimal;
  reason?: string;
}

/**
 * Quota status with all budget tracking fields
 */
export interface QuotaStatus {
  monthly_budget_usd: number;
  spent_usd: number;
  reserved_usd: number;
  remaining_usd: number;
  reset_date: string;
  hard_limit: boolean;
}

/**
 * Error type for quota operations - used for fail-closed policy
 */
export interface QuotaError {
  code: string;
  message: string;
}

export { syncQuotaPolicyFromPostgres };

/**
 * Result type for quota status lookups.
 * Fail-closed: Redis errors propagate as errors, not defaults.
 */
export type QuotaResult = Result<QuotaStatus, QuotaError>;

/**
 * Error type for reconciliation operations
 */
export interface ReconciliationError {
  code: string;
  message: string;
  reservationId: string;
}

/**
 * Result type for reconcileUsage operations.
 * Fail-closed: Redis errors propagate as errors, not zero values.
 */
type ReconciliationResult = Result<Decimal, ReconciliationError>;

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
      getIdempotencyTtlSeconds(),
      RESERVED_KEY_PREFIX,
      RESERVATION_HASH_PREFIX
    )) as (string | number)[];

    if (Array.isArray(result) && result[1] === 'not_found') {
      const nullData = await tryRecoverFromHash(reservationId);
      if (nullData) {
        const reservedKey = getReservedKey(nullData.userId, nullData.month);
        const hashKey = getReservationHashKey(nullData.userId, nullData.month);

        const pipeline = redis.pipeline();
        pipeline.incrby(reservedKey, -Number(nullData.amountMicro));
        pipeline.hdel(hashKey, reservationId);
        await pipeline.exec();

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
  model: string,
  idempotencyKey?: string
): Promise<Decimal> {
  const actualCost = calculateCost(actualUsage, model);
  const costMicro = toMicrodollars(actualCost);
  const month = getCurrentMonth();
  const quotaKey = getQuotaKey(userId, month);

  if (idempotencyKey) {
    const key = `${IDEMPOTENCY_RECORD_ONLY_PREFIX}${idempotencyKey}`;
    const ttl = getIdempotencyTtlSeconds();
    const set = await redis.setnx(key, '1');
    if (set === 0) {
      return new Decimal(0);
    }
    await redis.expire(key, ttl);
  }

  await redis.hincrby(quotaKey, 'spent', Number(costMicro));

  return actualCost;
}

/**
 * Reconcile usage after an LLM response.
 * Returns actualCost on success, error on failure (fail-closed).
 *
 * Previously returned Decimal(0) on errors, which allowed requests through
 * without proper quota accounting. Now propagates errors so the quota
 * middleware can reject the request.
 */
export async function reconcileUsage(
  reservationId: string,
  actualUsage: TokenUsage,
  model: string
): Promise<ReconciliationResult> {
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
      getIdempotencyTtlSeconds(),
      QUOTA_KEY_PREFIX,
      RESERVED_KEY_PREFIX,
      RESERVATION_HASH_PREFIX
    )) as (string | number)[];

    if (Array.isArray(result) && result[0] === 1) {
      return ok(actualCost);
    }

    if (Array.isArray(result) && result[1] === 'already_reconciled') {
      return ok(new Decimal(0));
    }

    if (Array.isArray(result) && result[1] === 'not_found') {
      const nullData = await tryRecoverFromHash(reservationId);
      if (nullData) {
        const quotaKey = getQuotaKey(nullData.userId, nullData.month);
        const reservedKey = getReservedKey(nullData.userId, nullData.month);
        const hashKey = getReservationHashKey(nullData.userId, nullData.month);

        const pipeline = redis.pipeline();
        pipeline.hincrby(quotaKey, 'spent', Number(costMicro));
        pipeline.incrby(reservedKey, -Number(nullData.amountMicro));
        pipeline.hdel(hashKey, reservationId);
        await pipeline.exec();

        logger.warn(
          { reservationId, userId: nullData.userId, month: nullData.month },
          'Reconciled expired reservation via hash fallback'
        );
        return ok(actualCost);
      }
      return err({
        code: 'reservation_not_found',
        message: 'Reservation not found and hash recovery failed',
        reservationId,
      });
    }

    return err({
      code: 'reconciliation_failed',
      message: 'Reconciliation script returned unexpected result',
      reservationId,
    });
  } catch (error) {
    logger.error({ error, reservationId }, 'Reconcile usage error');
    return err({
      code: 'redis_error',
      message: 'Failed to reconcile usage due to Redis error',
      reservationId,
    });
  }
}

function parseHardLimitFlag(value: string | null): boolean {
  if (value === '0' || value === 'false') {
    return false;
  }
  return true;
}

/**
 * Get quota status for a user.
 * Returns a Result<QuotaStatus, QuotaError> for fail-closed policy.
 *
 * Previously used safeReadOrNull which returned null on Redis errors,
 * causing the caller to fall back to defaults (fail-open). Now propagates
 * errors so the quota middleware can reject requests when quota status
 * cannot be determined.
 */
export async function getQuotaStatus(userId: string): Promise<QuotaResult> {
  const month = getCurrentMonth();
  await syncQuotaPolicyFromPostgres(userId, month);

  const quotaKey = getQuotaKey(userId, month);
  const reservedKey = getReservedKey(userId, month);

  let budget: string | null = null;
  let spent: string | null = null;
  let reserved: string | null = null;
  let hardRaw: string | null = null;

  try {
    const results = await Promise.all([
      redis.hget(quotaKey, 'budget'),
      redis.hget(quotaKey, 'spent'),
      redis.get(reservedKey),
      redis.hget(quotaKey, 'hard_limit'),
    ]);
    [budget, spent, reserved, hardRaw] = results;
  } catch (error) {
    logger.error({ error, userId }, 'Failed to get quota status from Redis');
    return err({
      code: 'quota_status_unavailable',
      message: 'Unable to determine quota status',
    });
  }

  const budgetDecimal = fromMicrodollars(budget || DEFAULT_BUDGET_MICRO);
  const spentDecimal = fromMicrodollars(spent || '0');
  const reservedDecimal = fromMicrodollars(reserved || '0');
  const remaining = budgetDecimal.minus(spentDecimal).minus(reservedDecimal);

  return ok({
    monthly_budget_usd: budgetDecimal.toNumber(),
    spent_usd: spentDecimal.toNumber(),
    reserved_usd: reservedDecimal.toNumber(),
    remaining_usd: Math.max(0, remaining.toNumber()),
    reset_date: getResetDate(),
    hard_limit: parseHardLimitFlag(hardRaw),
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

interface TopUpResult {
  allowed: boolean;
  mode: 'within_budget' | 'soft_overage' | 'hard_rejected' | 'not_found' | 'parse_error' | 'error';
}

export async function topUpReservation(
  reservationId: string,
  delta: Decimal
): Promise<TopUpResult> {
  const reservationKey = getReservationKey(reservationId);

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
  const deltaMicro = toMicrodollars(delta);

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

export async function cleanupOrphanedReservations(): Promise<number> {
  const nowMs = Date.now();
  const ttlMs = RESERVATION_TTL_SECONDS * 1000;
  let totalCleaned = 0;

  try {
    let cursor = '0';
    let iterations = 0;
    do {
      iterations++;
      if (iterations > MAX_SCAN_ITERATIONS) {
        logger.warn({ iterations }, 'Max SCAN iterations exceeded in cleanupOrphanedReservations');
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
        const cleaned = (await redis.eval(
          CLEANUP_ORPHAN_SCRIPT,
          1,
          hashKey,
          String(nowMs),
          String(ttlMs),
          String(getIdempotencyTtlSeconds()),
          RESERVATION_KEY_PREFIX,
          RESERVED_KEY_PREFIX,
          IDEMPOTENCY_CLEANUP_PREFIX
        )) as number;
        totalCleaned += cleaned;
      }
    } while (cursor !== '0');
  } catch (error) {
    logger.error({ error }, 'Cleanup error');
  }

  if (totalCleaned > 0) {
    for (let i = 0; i < totalCleaned; i++) {
      incrementQuotaOrphanCleaned();
    }
  }

  return totalCleaned;
}
