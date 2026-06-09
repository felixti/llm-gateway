import {
  QUOTA_KEY_PREFIX,
  RESERVATION_HASH_PREFIX,
  RESERVATION_KEY_PREFIX,
  RESERVED_KEY_PREFIX,
} from './constants';

export function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function getResetDate(): string {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.toISOString();
}

export function getQuotaKey(userId: string, month: string): string {
  return `${QUOTA_KEY_PREFIX}${userId}:${month}`;
}

export function getReservedKey(userId: string, month: string): string {
  return `${RESERVED_KEY_PREFIX}${userId}:${month}`;
}

export function getReservationKey(reservationId: string): string {
  return `${RESERVATION_KEY_PREFIX}${reservationId}`;
}

export function getReservationHashKey(userId: string, month: string): string {
  return `${RESERVATION_HASH_PREFIX}${userId}:${month}`;
}

export function generateReservationId(): string {
  return `res_${crypto.randomUUID()}`;
}
