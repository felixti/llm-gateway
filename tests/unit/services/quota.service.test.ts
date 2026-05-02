/**
 * Quota Service unit tests for Postgres → Redis policy sync and hard_limit propagation.
 * Uses an in-memory MockRedis bound onto the redis singleton and vi.mock for the data-access layer.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { Decimal } from 'decimal.js';
import * as metrics from '../../../src/observability/metrics';
import { redis } from '../../../src/db/redis';
import { MockRedis } from '../../integration/helpers/mock-redis';

let policyResolver: () => Promise<{ monthly_budget_usd: string; hard_limit: boolean } | null> =
  async () => null;
let policyCalls = 0;

vi.mock('../../../src/db/data-access', () => ({
  resolveUserId: vi.fn(),
  logRequestAudit: vi.fn(),
  getUserQuotaPolicyByPatSubject: async () => {
    policyCalls += 1;
    return policyResolver();
  },
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
}

let originalSyncFlag: string | undefined;

beforeEach(() => {
  bindMockRedis(new MockRedis());
  policyCalls = 0;
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

describe('quota.service Postgres policy sync', () => {
  test('hydrates Redis from Postgres policy and surfaces hard_limit=false', async () => {
    policyResolver = async () => ({
      monthly_budget_usd: '125.000000',
      hard_limit: false,
    });

    const { syncQuotaPolicyFromPostgres, getQuotaStatus } = await import(
      '../../../src/services/quota.service'
    );

    await syncQuotaPolicyFromPostgres('user-1', '2026-04');
    const status = await getQuotaStatus('user-1');

    expect(status.monthly_budget_usd).toBe(125);
    expect(status.hard_limit).toBe(false);
  });

  test('falls back to defaults when Postgres policy is missing', async () => {
    policyResolver = async () => null;

    const { syncQuotaPolicyFromPostgres, getQuotaStatus } = await import(
      '../../../src/services/quota.service'
    );

    await syncQuotaPolicyFromPostgres('user-2', '2026-04');
    const status = await getQuotaStatus('user-2');

    expect(status.monthly_budget_usd).toBe(50);
    expect(status.hard_limit).toBe(true);
  });

  test('checkAndReserve returns reservationId when within budget', async () => {
    policyResolver = async () => ({
      monthly_budget_usd: '50',
      hard_limit: true,
    });

    const { checkAndReserve } = await import('../../../src/services/quota.service');
    const result = await checkAndReserve('user-3', new Decimal('0.001'));
    expect(result.allowed).toBe(true);
    expect(result.reservationId).toMatch(/^res_[0-9a-f-]{36}$/i);
  });

  test('checkAndReserve passes TTL to Redis eval script', async () => {
    policyResolver = async () => ({
      monthly_budget_usd: '50',
      hard_limit: true,
    });

    const evalSpy = vi.fn(async () => [1, 'ok']);
    const r = redis as unknown as { eval: (...args: unknown[]) => Promise<unknown> };
    r.eval = evalSpy;

    const { checkAndReserve } = await import('../../../src/services/quota.service');
    const result = await checkAndReserve('user-ttl', new Decimal('0.001'));

    expect(result.allowed).toBe(true);
    expect(evalSpy).toHaveBeenCalledTimes(1);

    const callArgs = evalSpy.mock.calls[0] as unknown[];
    expect(callArgs[9]).toBe(300);

    const script = callArgs[0] as string;
    expect(script).toContain("'EX'");
    expect(script).toContain('hset');
  });
});

describe('quota.service edge cases', () => {
  test('checkAndReserve returns denied when Redis eval fails', async () => {
    policyResolver = async () => ({
      monthly_budget_usd: '100',
      hard_limit: true,
    });
    bindMockRedis(new MockRedis());
    const r = redis as unknown as { eval: (...args: unknown[]) => Promise<unknown> };
    r.eval = async () => {
      throw new Error('redis eval');
    };

    const { checkAndReserve } = await import('../../../src/services/quota.service');
    const result = await checkAndReserve('user-eval-fail', new Decimal('0.01'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Reservation failed');
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

  test('releaseReservation is a no-op when key is missing', async () => {
    const { releaseReservation } = await import('../../../src/services/quota.service');
    await expect(releaseReservation('res_never_existed')).resolves.toBeUndefined();
  });

  test('syncQuotaPolicyFromPostgres increments metric when policy lookup throws', async () => {
    const spy = vi.spyOn(metrics, 'incrementQuotaHydrationFailures');
    policyResolver = async () => {
      throw new Error('postgres unavailable');
    };

    const { syncQuotaPolicyFromPostgres } = await import('../../../src/services/quota.service');
    await syncQuotaPolicyFromPostgres('user-pg-throw', '2026-04');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
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

describe('quota.service sync gating', () => {
  test('skips sync when test env flag is unset', async () => {
    delete process.env.QUOTA_PG_SYNC_IN_TESTS;
    policyResolver = async () => null;
    policyCalls = 0;

    const { syncQuotaPolicyFromPostgres } = await import('../../../src/services/quota.service');
    await syncQuotaPolicyFromPostgres('user-4', '2026-04');
    expect(policyCalls).toBe(0);
  });
});
