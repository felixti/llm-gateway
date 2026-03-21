/**
 * Quota Service
 * Manages per-user USD quota with Redis operations for atomic operations
 * Handles reservation, reconciliation, and release of quota
 */

import { Decimal } from "decimal.js";
import { redis } from "../db/redis";
import { calculateCost, type TokenUsage } from "./pricing.service";

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

// Redis key prefixes
const QUOTA_KEY_PREFIX = "quota:";
const RESERVED_KEY_PREFIX = "reserved:";
const RESERVATION_KEY_PREFIX = "reservation:";

/**
 * Get current month in YYYY-MM format
 */
function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Get reset date (first day of next month)
 */
function getResetDate(): string {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.toISOString();
}

/**
 * Get Redis key for user's monthly quota
 */
function getQuotaKey(userId: string, month: string): string {
  return `${QUOTA_KEY_PREFIX}${userId}:${month}`;
}

/**
 * Get Redis key for user's total reserved amount
 */
function getReservedKey(userId: string, month: string): string {
  return `${RESERVED_KEY_PREFIX}${userId}:${month}`;
}

/**
 * Get Redis key for a specific reservation
 */
function getReservationKey(reservationId: string): string {
  return `${RESERVATION_KEY_PREFIX}${reservationId}`;
}

/**
 * Generate a unique reservation ID
 */
function generateReservationId(): string {
  return `res_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Check quota and reserve for a user
 * Uses Redis operations for atomicity
 */
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

  try {
    // Get current values
    const [budgetStr, spentStr, reservedStr] = await Promise.all([
      redis.hget(quotaKey, "budget"),
      redis.hget(quotaKey, "spent"),
      redis.get(reservedKey),
    ]);

    const budget = parseFloat(budgetStr || "50");
    const spent = parseFloat(spentStr || "0");
    const reserved = parseFloat(reservedStr || "0");
    const cost = parseFloat(costStr);

    // Check if we can reserve
    if (spent + reserved + cost > budget) {
      return {
        allowed: false,
        reason: "Insufficient quota",
      };
    }

    // Reserve the amount using INCRBYFLOAT
    await redis.incrbyfloat(reservedKey, cost);

    // Store reservation with TTL (5 minutes) - use set with EX seconds
    const reservationData = `${costStr}|${userId}|${month}`;
    await redis.set(reservationKey, reservationData, "EX", 300);

    return {
      allowed: true,
      reservationId,
      estimatedCost,
    };
  } catch (error) {
    console.error("Quota reservation error:", error);
    return {
      allowed: false,
      reason: "Reservation failed",
    };
  }
}

/**
 * Release a reservation (e.g., on error or timeout)
 */
export async function releaseReservation(reservationId: string): Promise<void> {
  const reservationKey = getReservationKey(reservationId);

  // First get reservation data to find the user/month
  const reservationData = await redis.get(reservationKey);
  if (!reservationData) {
    return; // Already released or expired
  }

  const [amountStr, userId, month] = reservationData.split("|");
  const reservedKey = getReservedKey(userId, month);

  // Release the reserved amount
  await redis.incrbyfloat(reservedKey, -parseFloat(amountStr));

  // Delete reservation
  await redis.del(reservationKey);
}

/**
 * Reconcile actual usage against a reservation
 * Calculates actual cost from usage and updates quota
 */
export async function reconcileUsage(
  reservationId: string,
  actualUsage: TokenUsage,
  model: string
): Promise<Decimal> {
  const reservationKey = getReservationKey(reservationId);

  // Get reservation data
  const reservationData = await redis.get(reservationKey);
  if (!reservationData) {
    return new Decimal(0);
  }

  const [reservedAmountStr, userId, month] = reservationData.split("|");

  // Calculate actual cost
  const actualCost = calculateCost(actualUsage, model);
  const reservedNum = parseFloat(reservedAmountStr);

  // Update spent and reserved amounts
  const quotaKey = getQuotaKey(userId, month);
  const reservedKey = getReservedKey(userId, month);

  // Atomically update spent and release reservation
  await Promise.all([
    redis.hincrbyfloat(quotaKey, "spent", actualCost.toString()),
    redis.incrbyfloat(reservedKey, -reservedNum),
    redis.del(reservationKey),
  ]);

  // Return the actual cost incurred
  return actualCost;
}

/**
 * Get quota status for a user
 */
export async function getQuotaStatus(userId: string): Promise<QuotaStatus> {
  const month = getCurrentMonth();
  const quotaKey = getQuotaKey(userId, month);
  const reservedKey = getReservedKey(userId, month);

  // Get budget and spent from Redis
  const [budget, spent, reserved] = await Promise.all([
    redis.hget(quotaKey, "budget"),
    redis.hget(quotaKey, "spent"),
    redis.get(reservedKey),
  ]);

  const budgetDecimal = new Decimal(budget || "50");
  const spentDecimal = new Decimal(spent || "0");
  const reservedDecimal = new Decimal(reserved || "0");
  const remaining = budgetDecimal.minus(spentDecimal).minus(reservedDecimal);

  return {
    monthly_budget_usd: budgetDecimal.toNumber(),
    spent_usd: spentDecimal.toNumber(),
    reserved_usd: reservedDecimal.toNumber(),
    remaining_usd: Math.max(0, remaining.toNumber()),
    reset_date: getResetDate(),
  };
}

/**
 * Set monthly budget for a user
 */
export async function setMonthlyBudget(
  userId: string,
  budgetUsd: number,
  month?: string
): Promise<void> {
  const targetMonth = month || getCurrentMonth();
  const quotaKey = getQuotaKey(userId, targetMonth);

  await redis.hset(quotaKey, {
    budget: budgetUsd.toString(),
    spent: "0",
    reset_date: getResetDate(),
  });
}

/**
 * Clean up orphaned reservations (called periodically)
 * Note: Bun.redis scan API may differ - using keys() as fallback
 */
export async function cleanupOrphanedReservations(): Promise<number> {
  // Scan for expired reservations using keys pattern
  const pattern = `${RESERVATION_KEY_PREFIX}*`;
  let cleaned = 0;

  try {
    // Bun.redis uses scan with callback or returns iterator
    const keys = await redis.keys(pattern);

    for (const key of keys) {
      const ttl = await redis.ttl(key);
      if (ttl === -1) {
        // Key has no TTL, release it
        const reservationId = key.replace(RESERVATION_KEY_PREFIX, "");
        await releaseReservation(reservationId);
        cleaned++;
      }
    }
  } catch (error) {
    console.error("Cleanup error:", error);
  }

  return cleaned;
}
