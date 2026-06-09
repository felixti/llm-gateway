import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { Decimal } from 'decimal.js';
import { MockRedis } from '../../integration/helpers/mock-redis';
import { redis } from '../../../src/db/redis';
import { topUpReservation, checkAndReserve } from '../../../src/services/quota.service';

vi.mock('../../../src/db/data-access', () => ({
  resolveUserId: vi.fn(),
  logRequestAudit: vi.fn(),
  getUserQuotaPolicyByPatSubject: vi.fn(),
}));

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as Record<string, unknown>;
  r.get = mock.get.bind(mock);
  r.set = mock.set.bind(mock);
  r.setex = mock.setex.bind(mock);
  r.eval = mock.eval.bind(mock);
  r.hget = mock.hget.bind(mock);
  r.hgetall = mock.hgetall.bind(mock);
  r.hset = mock.hset.bind(mock);
  r.pipeline = mock.pipeline.bind(mock);
  r.incrbyfloat = mock.incrbyfloat.bind(mock);
  r.del = mock.del.bind(mock);
  r.ping = mock.ping.bind(mock);
  r.scan = mock.scan.bind(mock);
  r.ttl = mock.ttl.bind(mock);
  r.exists = mock.exists.bind(mock);
  r.hdel = mock.hdel.bind(mock);
  r.hincrby = mock.hincrby.bind(mock);
  const mockAny = mock as unknown as Record<string, unknown>;
  if (typeof mockAny.incrby === 'function') {
    r.incrby = mockAny.incrby.bind(mock);
  }
}

describe('topUpReservation', () => {
  let mock: MockRedis;
  let originalSyncFlag: string | undefined;

  beforeEach(() => {
    mock = new MockRedis();
    bindMockRedis(mock);
    originalSyncFlag = process.env.QUOTA_PG_SYNC_IN_TESTS;
    delete process.env.QUOTA_PG_SYNC_IN_TESTS;
  });

  afterEach(() => {
    if (originalSyncFlag === undefined) {
      delete process.env.QUOTA_PG_SYNC_IN_TESTS;
    } else {
      process.env.QUOTA_PG_SYNC_IN_TESTS = originalSyncFlag;
    }
  });

  test('within budget — top-up succeeds and increments reserved', async () => {
    await mock.hset('quota:user-1:2026-05', { budget: '1000000', spent: '0', hard_limit: '1' });
    const r = await checkAndReserve('user-1', new Decimal('0.10'));
    expect(r.allowed).toBe(true);

    const result = await topUpReservation(r.reservationId!, new Decimal('0.30'));
    expect(result.mode).toBe('within_budget');
    expect(result.allowed).toBe(true);

    const reserved = await mock.get('reserved:user-1:2026-05');
    expect(reserved).toBe('400000');
  });

  test('hard_limit=true and over budget — top-up rejected', async () => {
    await mock.hset('quota:user-2:2026-05', { budget: '1000000', spent: '900000', hard_limit: '1' });
    const r = await checkAndReserve('user-2', new Decimal('0.05'));
    expect(r.allowed).toBe(true);
    const result = await topUpReservation(r.reservationId!, new Decimal('0.20'));
    expect(result.mode).toBe('hard_rejected');
    expect(result.allowed).toBe(false);
    const reserved = await mock.get('reserved:user-2:2026-05');
    expect(reserved).toBe('50000');
  });

  test('hard_limit=false and over budget — top-up allowed with soft_overage', async () => {
    await mock.hset('quota:user-3:2026-05', { budget: '1000000', spent: '900000', hard_limit: '0' });
    const r = await checkAndReserve('user-3', new Decimal('0.05'));
    expect(r.allowed).toBe(true);
    const result = await topUpReservation(r.reservationId!, new Decimal('0.20'));
    expect(result.mode).toBe('soft_overage');
    expect(result.allowed).toBe(true);
    const reserved = await mock.get('reserved:user-3:2026-05');
    expect(reserved).toBe('250000');
  });

  test('zero delta — no-op', async () => {
    await mock.hset('quota:user-4:2026-05', { budget: '1000000', spent: '0', hard_limit: '1' });
    const r = await checkAndReserve('user-4', new Decimal('0.10'));
    const result = await topUpReservation(r.reservationId!, new Decimal('0'));
    expect(result.mode).toBe('within_budget');
    expect(result.allowed).toBe(true);
    const reserved = await mock.get('reserved:user-4:2026-05');
    expect(reserved).toBe('100000');
  });

  test('negative delta (cheaper fallback) — decrements reserved', async () => {
    await mock.hset('quota:user-5:2026-05', { budget: '1000000', spent: '0', hard_limit: '1' });
    const r = await checkAndReserve('user-5', new Decimal('0.50'));
    const result = await topUpReservation(r.reservationId!, new Decimal('-0.30'));
    expect(result.mode).toBe('within_budget');
    expect(result.allowed).toBe(true);
    const reserved = await mock.get('reserved:user-5:2026-05');
    expect(reserved).toBe('200000');
  });

  test('reservation not found — returns not_found', async () => {
    const result = await topUpReservation('nonexistent-id', new Decimal('0.10'));
    expect(result.mode).toBe('not_found');
    expect(result.allowed).toBe(false);
  });
});
