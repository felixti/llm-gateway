import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, it, expect, beforeEach } from 'vitest';
import { budgetKeys } from '@shared/budget/keys';
import { syncBudgetPolicy } from './policy-sync';

function createTestRedis(): Redis {
  return new RedisMock({ data: {} }) as unknown as Redis;
}

describe('syncBudgetPolicy', () => {
  const scope = '{proj:proj1}';
  let redis: Redis;

  beforeEach(() => {
    redis = createTestRedis();
  });

  it('writes cap, hard, period, and version to policy hash', async () => {
    await syncBudgetPolicy(redis, scope, {
      principalId: 'proj1',
      scopeKind: 'project',
      capUsd: '100.000000',
      period: 'monthly',
      hard: true,
    });

    const keys = budgetKeys(scope);
    const policy = await redis.hgetall(keys.policy);
    expect(policy).toEqual({
      cap_micro: '100000000',
      hard: '1',
      period: 'monthly',
      'policy:version': '1',
    });
  });

  it('writes hard=0 for soft cap', async () => {
    await syncBudgetPolicy(redis, scope, {
      principalId: 'proj1',
      scopeKind: 'project',
      capUsd: '10.000000',
      period: 'daily',
      hard: false,
    });

    const keys = budgetKeys(scope);
    expect(await redis.hget(keys.policy, 'hard')).toBe('0');
    expect(await redis.hget(keys.policy, 'period')).toBe('daily');
  });
});
