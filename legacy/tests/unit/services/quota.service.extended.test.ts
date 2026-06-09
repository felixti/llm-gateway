import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { isErr } from '../../../src/utils/result';
import { redis } from '../../../src/db/redis';
import { MockRedis } from '../../integration/helpers/mock-redis';

let policyResolver: () => Promise<{ monthly_budget_usd: string; hard_limit: boolean } | null> =
  async () => null;

vi.mock('../../../src/db/data-access', () => ({
  resolveUserId: vi.fn(),
  logRequestAudit: vi.fn(),
  getUserQuotaPolicyByPatSubject: async () => policyResolver(),
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
  r.scan = mock.scan.bind(mock);
}

let originalSyncFlag: string | undefined;

beforeEach(() => {
  bindMockRedis(new MockRedis());
  policyResolver = async () => null;
  originalSyncFlag = process.env.QUOTA_PG_SYNC_IN_TESTS;
  process.env.QUOTA_PG_SYNC_IN_TESTS = 'true';
});

afterEach(() => {
  if (originalSyncFlag === undefined) {
    delete process.env.QUOTA_PG_SYNC_IN_TESTS;
  } else {
    process.env.QUOTA_PG_SYNC_IN_TESTS = originalSyncFlag;
  }
});

describe('quota.service getQuotaStatus failure path', () => {
  test('returns defaults when Redis hget throws', async () => {
    policyResolver = async () => ({
      monthly_budget_usd: '100',
      hard_limit: true,
    });

    const mock = new MockRedis();
    bindMockRedis(mock);

    const r = redis as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const origHget = r.hget?.bind(mock);
    r.hget = async (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('quota:')) {
        throw new Error('redis hget failed');
      }
      return origHget ? origHget(...args) : null;
    };

    const { getQuotaStatus } = await import('../../../src/services/quota.service');
    const result = await getQuotaStatus('user-redis-fail');
    // With Redis failing, getQuotaStatus returns error (fail-closed)
    if (!isErr(result)) {
      throw new Error('Expected error result for user-reserved-fail');
    }
    expect(result.error.code).toBe('quota_status_unavailable');
  });

  test('returns defaults when Redis get throws for reserved key', async () => {
    policyResolver = async () => ({
      monthly_budget_usd: '100',
      hard_limit: true,
    });

    const mock = new MockRedis();
    bindMockRedis(mock);

    const r = redis as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const origGet = r.get?.bind(mock);
    r.get = async (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('reserved:')) {
        throw new Error('redis get failed');
      }
      return origGet ? origGet(...args) : null;
    };

    const { getQuotaStatus } = await import('../../../src/services/quota.service');
    const result = await getQuotaStatus('user-reserved-fail');
    // With Redis failing, getQuotaStatus returns error (fail-closed)
    if (!isErr(result)) {
      throw new Error('Expected error result for user-reserved-fail');
    }
    expect(result.error.code).toBe('quota_status_unavailable');
  });
});

describe('quota.service cleanupOrphanedReservations failure path', () => {
  test('returns 0 when Redis eval throws during cleanup', async () => {
    const mock = new MockRedis();
    bindMockRedis(mock);

    const r = redis as unknown as { eval: (...args: unknown[]) => Promise<unknown> };
    r.eval = async () => {
      throw new Error('eval exploded');
    };

    await mock.hset('reservations_meta:user-orph:2026-04', {
      res_123: '1000|user-orph|2026-04|1000',
    });

    const { cleanupOrphanedReservations } = await import(
      '../../../src/services/quota.service'
    );
    const cleaned = await cleanupOrphanedReservations();
    expect(cleaned).toBe(0);
  });
});

describe('quota.service reconcileUsage failure path', () => {
  test('returns zero when Redis eval throws', async () => {
    const mock = new MockRedis();
    bindMockRedis(mock);

    const r = redis as unknown as { eval: (...args: unknown[]) => Promise<unknown> };
    r.eval = async () => {
      throw new Error('eval failed');
    };

    const { reconcileUsage } = await import('../../../src/services/quota.service');
    const resultCost = await reconcileUsage(
      'res_eval_fail',
      { prompt_tokens: 1, completion_tokens: 1 },
      'gpt-5-mini'
    );
    expect(isErr(resultCost)).toBe(true);
    if (isErr(resultCost)) {
      expect(resultCost.error.code).toBe('redis_error');
    }
  });
});
