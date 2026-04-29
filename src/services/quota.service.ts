import { env } from '@/config/env';
import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
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
}

const QUOTA_KEY_PREFIX = 'quota:';
const RESERVED_KEY_PREFIX = 'reserved:';
const RESERVATION_KEY_PREFIX = 'reservation:';

const RESERVATION_TTL_SECONDS = env.QUOTA_RESERVATION_TTL_SECONDS;
const DEFAULT_BUDGET = 50;

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

const CHECK_AND_RESERVE_SCRIPT = `
  local quotaKey = KEYS[1]
  local reservedKey = KEYS[2]
  local reservationKey = KEYS[3]
  local cost = tonumber(ARGV[1])
  local reservationData = ARGV[2]
  local ttl = tonumber(ARGV[3])
  local defaultBudget = tonumber(ARGV[4])
  
  -- Get current values
  local budget = tonumber(redis.call('hget', quotaKey, 'budget') or defaultBudget)
  local spent = tonumber(redis.call('hget', quotaKey, 'spent') or 0)
  local reserved = tonumber(redis.call('get', reservedKey) or 0)
  
  -- Check if we can reserve
  if spent + reserved + cost > budget then
    return {0, 'insufficient_quota'}
  end
  
  -- Reserve the amount
  redis.call('incrbyfloat', reservedKey, cost)
  
  -- Store reservation with TTL
  redis.call('setex', reservationKey, ttl, reservationData)
  
  return {1, 'ok'}
`;

export async function checkAndReserve(
  userId: string,
  estimatedCost: Decimal
): Promise<QuotaReservation> {
  const month = getCurrentMonth();
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

export async function getQuotaStatus(userId: string): Promise<QuotaStatus> {
  const month = getCurrentMonth();
  const quotaKey = getQuotaKey(userId, month);
  const reservedKey = getReservedKey(userId, month);

  const [budget, spent, reserved] = await Promise.all([
    redis.hget(quotaKey, 'budget'),
    redis.hget(quotaKey, 'spent'),
    redis.get(reservedKey),
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
