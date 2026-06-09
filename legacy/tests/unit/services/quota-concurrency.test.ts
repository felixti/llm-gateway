import { beforeEach, describe, expect, test, vi } from 'bun:test';
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
  r.pipeline = mock.pipeline.bind(mock);
  r.incrby = mock.incrby.bind(mock);
  r.incrbyfloat = mock.incrbyfloat.bind(mock);
  r.del = mock.del.bind(mock);
  r.ping = mock.ping.bind(mock);
  r.scan = mock.scan.bind(mock);
  r.ttl = mock.ttl.bind(mock);
}

vi.mock('../../../src/db/data-access', () => ({
  resolveUserId: vi.fn(),
  logRequestAudit: vi.fn(),
  getUserQuotaPolicyByPatSubject: vi.fn(async () => ({
    monthly_budget_usd: '0.10',
    hard_limit: true,
  })),
}));

describe('quota.service concurrent reservations', () => {
  beforeEach(() => {
    process.env.QUOTA_PG_SYNC_IN_TESTS = 'true';
    bindMockRedis(new MockRedis());
  });

  test('parallel checkAndReserve calls never reserve more than monthly budget', async () => {
    const { checkAndReserve, getQuotaStatus } = await import('../../../src/services/quota.service');

    const results = await Promise.all(
      Array.from({ length: 25 }, () => checkAndReserve('user-concurrent', new Decimal('0.01')))
    );

    const allowed = results.filter((result) => result.allowed);
    const result = await getQuotaStatus('user-concurrent');
    if (!result.ok) throw new Error('getQuotaStatus failed: ' + String(result.error));
    const status = result.value;

    expect(allowed).toHaveLength(10);
    expect(status.reserved_usd).toBeLessThanOrEqual(0.1);
    expect(status.remaining_usd).toBe(0);
  });
});
