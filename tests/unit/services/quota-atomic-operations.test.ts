/**
 * Tests for atomic Lua-script quota operations: release, reconcile, cleanup.
 * Covers idempotency guards, microdollar precision, and hash fallback paths.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { Decimal } from 'decimal.js';
import { redis } from '../../../src/db/redis';
import { MockRedis } from '../../integration/helpers/mock-redis';

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as Record<string, unknown>;
  r.get = mock.get.bind(mock);
  r.set = mock.set.bind(mock);
  r.setex = mock.setex.bind(mock);
  r.eval = mock.eval.bind(mock);
  r.hget = mock.hget.bind(mock);
  r.hgetall = mock.hgetall.bind(mock);
  r.hset = mock.hset.bind(mock);
  r.hdel = mock.hdel.bind(mock);
  r.exists = mock.exists.bind(mock);
  r.pipeline = mock.pipeline.bind(mock);
  r.incrbyfloat = mock.incrbyfloat.bind(mock);
  r.del = mock.del.bind(mock);
  r.ping = mock.ping.bind(mock);
  r.scan = mock.scan.bind(mock);
  r.ttl = mock.ttl.bind(mock);
}

vi.mock('../../../src/services/pricing.service', () => ({
  calculateCost: () => new Decimal('0.05'),
}));

vi.mock('../../../src/db/data-access', () => ({
  resolveUserId: vi.fn(),
  logRequestAudit: vi.fn(),
  getUserQuotaPolicyByPatSubject: vi.fn(),
}));

describe('quota atomic release', () => {
  beforeEach(() => {
    bindMockRedis(new MockRedis());
  });

  test('releaseReservation is idempotent — second call is a no-op', async () => {
    const { checkAndReserve, releaseReservation } = await import(
      '../../../src/services/quota.service'
    );
    const result = await checkAndReserve('user-idem-rel', new Decimal('0.05'));
    expect(result.allowed).toBe(true);

    const reservationId = result.reservationId!;
    await releaseReservation(reservationId);

    // Second release should not throw and should be a no-op
    await expect(releaseReservation(reservationId)).resolves.toBeUndefined();
  });

  test('releaseReservation decrements reserved by exact microdollar amount', async () => {
    const { checkAndReserve, releaseReservation } = await import(
      '../../../src/services/quota.service'
    );
    const result = await checkAndReserve('user-exact-rel', new Decimal('0.05'));
    expect(result.allowed).toBe(true);

    const reservationId = result.reservationId!;
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const reservedKey = `reserved:user-exact-rel:${month}`;

    // Before release: reserved should be the microdollar amount
    const reservedBefore = await redis.get(reservedKey);
    expect(Number(reservedBefore)).toBeGreaterThan(0);

    await releaseReservation(reservationId);

    const reservedAfter = await redis.get(reservedKey);
    // After release: reserved should be 0 or null
    expect(Number(reservedAfter || '0')).toBe(0);
  });

  test('releaseReservation sets idempotency flag in Redis', async () => {
    const { checkAndReserve, releaseReservation } = await import(
      '../../../src/services/quota.service'
    );
    const result = await checkAndReserve('user-idem-flag', new Decimal('0.05'));
    expect(result.allowed).toBe(true);

    const reservationId = result.reservationId!;
    await releaseReservation(reservationId);

    const idempotencyKey = `released:${reservationId}`;
    const flag = await redis.get(idempotencyKey);
    expect(flag).not.toBeNull();
  });

  test('releaseReservation is a no-op when key is missing', async () => {
    const { releaseReservation } = await import('../../../src/services/quota.service');
    await expect(releaseReservation('res_never_existed')).resolves.toBeUndefined();
  });
});

describe('quota atomic reconcile', () => {
  beforeEach(() => {
    bindMockRedis(new MockRedis());
  });

  test('reconcileUsage is idempotent — second call returns 0', async () => {
    const { checkAndReserve, reconcileUsage } = await import(
      '../../../src/services/quota.service'
    );
    const result = await checkAndReserve('user-idem-rec', new Decimal('0.05'));
    expect(result.allowed).toBe(true);

    const reservationId = result.reservationId!;
    const cost1 = await reconcileUsage(
      reservationId,
      { prompt_tokens: 10, completion_tokens: 5 },
      'gpt-4o'
    );
    expect(cost1.toNumber()).toBe(0.05);

    // Second reconcile should return 0 (idempotent)
    const cost2 = await reconcileUsage(
      reservationId,
      { prompt_tokens: 10, completion_tokens: 5 },
      'gpt-4o'
    );
    expect(cost2.toNumber()).toBe(0);
  });

  test('reconcileUsage sets idempotency flag in Redis', async () => {
    const { checkAndReserve, reconcileUsage } = await import(
      '../../../src/services/quota.service'
    );
    const result = await checkAndReserve('user-idem-rec-flag', new Decimal('0.05'));
    expect(result.allowed).toBe(true);

    const reservationId = result.reservationId!;
    await reconcileUsage(reservationId, { prompt_tokens: 10, completion_tokens: 5 }, 'gpt-4o');

    const idempotencyKey = `reconciled:${reservationId}`;
    const flag = await redis.get(idempotencyKey);
    expect(flag).not.toBeNull();
  });

  test('reconcileUsage records exact microdollar cost to spent', async () => {
    const { checkAndReserve, reconcileUsage } = await import(
      '../../../src/services/quota.service'
    );
    const result = await checkAndReserve('user-exact-rec', new Decimal('0.05'));
    expect(result.allowed).toBe(true);

    const reservationId = result.reservationId!;
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const quotaKey = `quota:user-exact-rec:${month}`;

    await reconcileUsage(reservationId, { prompt_tokens: 10, completion_tokens: 5 }, 'gpt-4o');

    const spent = await redis.hget(quotaKey, 'spent');
    // spent should be microdollar integer (0.05 * 1_000_000 = 50000)
    expect(spent).toBe('50000');
  });

  test('reconcileUsage returns zero when reservation is missing', async () => {
    const { reconcileUsage } = await import('../../../src/services/quota.service');
    const cost = await reconcileUsage(
      'res_missing',
      { prompt_tokens: 1, completion_tokens: 1 },
      'gpt-5-mini'
    );
    expect(cost.toNumber()).toBe(0);
  });

  test('reconcileUsage bills and releases an expired reservation recovered from hash', async () => {
    const { checkAndReserve, reconcileUsage } = await import(
      '../../../src/services/quota.service'
    );
    const reserveResult = await checkAndReserve('user-expired-rec', new Decimal('0.05'));
    expect(reserveResult.allowed).toBe(true);

    const reservationId = reserveResult.reservationId!;
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const quotaKey = `quota:user-expired-rec:${month}`;
    const reservedKey = `reserved:user-expired-rec:${month}`;
    const reservationKey = `reservation:${reservationId}`;
    const hashKey = `reservations_meta:user-expired-rec:${month}`;

    // Simulate reservation expiry by deleting the key
    await redis.del(reservationKey);

    const cost = await reconcileUsage(
      reservationId,
      { prompt_tokens: 10, completion_tokens: 5 },
      'gpt-4o'
    );

    expect(cost.toString()).toBe('0.05');
    expect(await redis.hget(quotaKey, 'spent')).toBe('50000');
    expect(Number(await redis.get(reservedKey) || '0')).toBe(0);
    expect(await redis.hget(hashKey, reservationId)).toBeNull();
  });
});

describe('quota atomic cleanup', () => {
  beforeEach(() => {
    bindMockRedis(new MockRedis());
  });

  test('cleanupOrphanedReservations is idempotent — second call cleans 0', async () => {
    const { checkAndReserve, cleanupOrphanedReservations } = await import(
      '../../../src/services/quota.service'
    );
    const result = await checkAndReserve('user-idem-cleanup', new Decimal('0.05'));
    expect(result.allowed).toBe(true);

    const reservationId = result.reservationId!;
    const reservationKey = `reservation:${reservationId}`;

    // Simulate expiry
    await redis.del(reservationKey);

    const futureTime = Date.now() + 600000;
    const origNow = Date.now;
    Date.now = () => futureTime;

    const cleaned1 = await cleanupOrphanedReservations();
    expect(cleaned1).toBeGreaterThanOrEqual(1);

    const cleaned2 = await cleanupOrphanedReservations();
    expect(cleaned2).toBe(0);

    Date.now = origNow;
  });

  test('cleanupOrphanedReservations decrements reserved for expired reservations', async () => {
    const { checkAndReserve, cleanupOrphanedReservations } = await import(
      '../../../src/services/quota.service'
    );
    const result = await checkAndReserve('user-cleanup-dec', new Decimal('0.05'));
    expect(result.allowed).toBe(true);

    const reservationId = result.reservationId!;
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const reservedKey = `reserved:user-cleanup-dec:${month}`;
    const reservationKey = `reservation:${reservationId}`;
    const hashKey = `reservations_meta:user-cleanup-dec:${month}`;

    await redis.del(reservationKey);

    const futureTime = Date.now() + 600000;
    const origNow = Date.now;
    Date.now = () => futureTime;

    const cleaned = await cleanupOrphanedReservations();
    Date.now = origNow;

    expect(cleaned).toBeGreaterThanOrEqual(1);

    const reserved = await redis.get(reservedKey);
    expect(Number(reserved || '0')).toBe(0);

    const hashData = await redis.hget(hashKey, reservationId);
    expect(hashData).toBeNull();
  });

  test('cleanupOrphanedReservations skips active reservations', async () => {
    const { checkAndReserve, cleanupOrphanedReservations } = await import(
      '../../../src/services/quota.service'
    );
    const result = await checkAndReserve('user-cleanup-active', new Decimal('0.05'));
    expect(result.allowed).toBe(true);

    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const reservedKey = `reserved:user-cleanup-active:${month}`;

    const cleaned = await cleanupOrphanedReservations();
    expect(cleaned).toBe(0);

    const reserved = await redis.get(reservedKey);
    expect(Number(reserved)).toBeGreaterThan(0);
  });

  test('cleanupOrphanedReservations returns zero when scan fails', async () => {
    bindMockRedis(new MockRedis());
    const r = redis as unknown as { scan: (...args: unknown[]) => Promise<unknown> };
    r.scan = async () => {
      throw new Error('scan down');
    };

    const { cleanupOrphanedReservations } = await import('../../../src/services/quota.service');
    const cleaned = await cleanupOrphanedReservations();
    expect(cleaned).toBe(0);
  });
});
