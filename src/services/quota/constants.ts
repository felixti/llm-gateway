import { env } from '@/config/env';
import { Decimal } from 'decimal.js';
import { toMicrodollars } from './money';

export const QUOTA_KEY_PREFIX = 'quota:';
export const RESERVED_KEY_PREFIX = 'reserved:';
export const RESERVATION_KEY_PREFIX = 'reservation:';
export const RESERVATION_HASH_PREFIX = 'reservations_meta:';
export const IDEMPOTENCY_RELEASE_PREFIX = 'released:';
export const IDEMPOTENCY_RECONCILE_PREFIX = 'reconciled:';
export const IDEMPOTENCY_CLEANUP_PREFIX = 'cleanup:';

export const RESERVATION_TTL_SECONDS = env.QUOTA_RESERVATION_TTL_SECONDS;
export const DEFAULT_BUDGET_USD = 50;
export const DEFAULT_BUDGET_MICRO = toMicrodollars(new Decimal(DEFAULT_BUDGET_USD));
export const DB_POLICY_SYNC_INTERVAL_MS = 60_000;
export const MAX_SCAN_ITERATIONS = 100;

export function getIdempotencyTtlSeconds(): number {
  return env.QUOTA_IDEMPOTENCY_TTL_SECONDS;
}
