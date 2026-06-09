import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { budgetKeys } from '@shared/budget/keys';
import { createBudgetStore } from './store';

function createTestRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

describe('createBudgetStore', () => {
  const scope = '{user:test}';
  let redis: Redis;
  let store: ReturnType<typeof createBudgetStore>;

  beforeEach(async () => {
    redis = createTestRedis();
    store = createBudgetStore(redis);
    const keys = budgetKeys(scope);
    await redis.hset(keys.policy, 'cap_micro', '1000000', 'hard', '1');
    await redis.set(keys.spent, '0');
    await redis.set(keys.reserved, '0');
  });

  it('reserves budget when under cap', async () => {
    const result = await store.reserve(scope, 'res-1', 100_000n, 300);
    expect(result).toBe('ok');

    const keys = budgetKeys(scope);
    expect(await redis.get(keys.reserved)).toBe('100000');
    expect(await redis.get(keys.reservation('res-1'))).toBe('100000');
  });

  it('rejects reserve when hard cap would be exceeded', async () => {
    const keys = budgetKeys(scope);
    await redis.set(keys.spent, '950000');

    const result = await store.reserve(scope, 'res-2', 100_000n, 300);
    expect(result).toBe('insufficient');
    expect(await redis.get(keys.reserved)).toBe('0');
  });

  it('commits idempotently by request id', async () => {
    await store.reserve(scope, 'res-3', 200_000n, 300);

    expect(await store.commit(scope, 'res-3', 'req-1', 150_000n, 604_800)).toBe('ok');
    expect(await store.commit(scope, 'res-3', 'req-1', 150_000n, 604_800)).toBe('already');

    const keys = budgetKeys(scope);
    expect(await redis.get(keys.spent)).toBe('150000');
    expect(await redis.get(keys.reserved)).toBe('0');
    expect(await redis.get(keys.reservation('res-3'))).toBeNull();
  });

  it('releases reserved amount without committing spend', async () => {
    await store.reserve(scope, 'res-4', 300_000n, 300);
    await store.release(scope, 'res-4');

    const keys = budgetKeys(scope);
    expect(await redis.get(keys.reserved)).toBe('0');
    expect(await redis.get(keys.spent)).toBe('0');
    expect(await redis.get(keys.reservation('res-4'))).toBeNull();
  });
});
