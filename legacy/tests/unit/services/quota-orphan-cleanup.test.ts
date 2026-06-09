import { isOk } from '@/utils/result';
import { describe, expect, test, vi, beforeEach } from 'bun:test';
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

describe('quota service orphan cleanup', () => {
  beforeEach(() => {
    bindMockRedis(new MockRedis());
  });

  test('reservation creates hash entry via Lua script', async () => {
    const { checkAndReserve } = await import('../../../src/services/quota.service');
    const result = await checkAndReserve('user-1', new Decimal('0.05'));

    expect(result.allowed).toBe(true);
    expect(result.reservationId).toBeDefined();

    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const hashKey = `reservations_meta:user-1:${month}`;
    const hashData = await redis.hget(hashKey, result.reservationId!);
    expect(hashData).toBeTruthy();
    expect(hashData).toContain('50000');
  });

  test('reconcileUsage cleans up hash entry', async () => {
    const { checkAndReserve, reconcileUsage } = await import('../../../src/services/quota.service');
    const reserveResult = await checkAndReserve('user-2', new Decimal('0.05'));
    expect(reserveResult.allowed).toBe(true);

    const reservationId = reserveResult.reservationId!;
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const hashKey = `reservations_meta:user-2:${month}`;

    await reconcileUsage(reservationId, { prompt_tokens: 10, completion_tokens: 5 }, 'gpt-4o');

    const hashData = await redis.hget(hashKey, reservationId);
    expect(hashData).toBeNull();
  });

  test('reconcileUsage bills and releases an expired reservation recovered from hash', async () => {
    const { checkAndReserve, reconcileUsage } = await import('../../../src/services/quota.service');
    const reserveResult = await checkAndReserve('user-expired', new Decimal('0.05'));
    expect(reserveResult.allowed).toBe(true);

    const reservationId = reserveResult.reservationId!;
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const quotaKey = `quota:user-expired:${month}`;
    const reservedKey = `reserved:user-expired:${month}`;
    const reservationKey = `reservation:${reservationId}`;
    const hashKey = `reservations_meta:user-expired:${month}`;

    await redis.del(reservationKey);

    const costResult = await reconcileUsage(
      reservationId,
      { prompt_tokens: 10, completion_tokens: 5 },
      'gpt-4o'
    );
    if (!isOk(costResult)) throw new Error('reconcileUsage failed');
    const cost = costResult.value;

    expect(cost.toString()).toBe('0.05');
    expect(await redis.hget(quotaKey, 'spent')).toBe('50000');
    expect(Number(await redis.get(reservedKey) || '0')).toBe(0);
    expect(await redis.hget(hashKey, reservationId)).toBeNull();
  });

  test('releaseReservation cleans up hash entry', async () => {
    const { checkAndReserve, releaseReservation } = await import('../../../src/services/quota.service');
    const reserveResult = await checkAndReserve('user-3', new Decimal('0.05'));
    expect(reserveResult.allowed).toBe(true);

    const reservationId = reserveResult.reservationId!;
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const hashKey = `reservations_meta:user-3:${month}`;

    await releaseReservation(reservationId);

    const hashData = await redis.hget(hashKey, reservationId);
    expect(hashData).toBeNull();
  });

  test('cleanupOrphanedReservations decrements reserved for expired reservations', async () => {
    const { checkAndReserve, cleanupOrphanedReservations } = await import('../../../src/services/quota.service');
    const reserveResult = await checkAndReserve('user-4', new Decimal('0.05'));
    expect(reserveResult.allowed).toBe(true);

    const reservationId = reserveResult.reservationId!;
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const reservedKey = `reserved:user-4:${month}`;
    const reservationKey = `reservation:${reservationId}`;
    const hashKey = `reservations_meta:user-4:${month}`;

    await redis.del(reservationKey);

    const futureTime = Date.now() + 600000;
    const originalDateNow = Date.now;
    Date.now = () => futureTime;

    const cleaned = await cleanupOrphanedReservations();
    Date.now = originalDateNow;

    expect(cleaned).toBeGreaterThanOrEqual(1);

    const reserved = await redis.get(reservedKey);
    expect(Number(reserved)).toBe(0);

    const hashData = await redis.hget(hashKey, reservationId);
    expect(hashData).toBeNull();
  });

  test('cleanupOrphanedReservations skips active reservations', async () => {
    const { checkAndReserve, cleanupOrphanedReservations } = await import('../../../src/services/quota.service');
    const reserveResult = await checkAndReserve('user-5', new Decimal('0.05'));
    expect(reserveResult.allowed).toBe(true);

    const reservationId = reserveResult.reservationId!;
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const reservedKey = `reserved:user-5:${month}`;

    const cleaned = await cleanupOrphanedReservations();
    expect(cleaned).toBe(0);

    const reserved = await redis.get(reservedKey);
    expect(Number(reserved)).toBe(50000);
  });
});
