import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';
import { budgetKeys } from '@shared/budget/keys';
import { createRateStore } from './store';

function createTestRedis(): Redis {
  return new RedisMock({ data: {} }) as unknown as Redis;
}

describe('createRateStore', () => {
  it('allows requests under RPM and TPM limits', async () => {
    const scope = '{user:rate-ok}';
    const store = createRateStore(createTestRedis());

    expect(await store.checkAndConsume(scope, 10, 1000, 100)).toBe('ok');
    expect(await store.checkAndConsume(scope, 10, 1000, 100)).toBe('ok');
  });

  it('returns rpm_exceeded when request count exceeds limit', async () => {
    const scope = '{user:rate-rpm}';
    const store = createRateStore(createTestRedis());

    for (let i = 0; i < 3; i++) {
      expect(await store.checkAndConsume(scope, 3, 10_000, 0)).toBe('ok');
    }
    expect(await store.checkAndConsume(scope, 3, 10_000, 0)).toBe('rpm_exceeded');
  });

  it('returns tpm_exceeded when token count exceeds limit', async () => {
    const scope = '{user:rate-tpm}';
    const store = createRateStore(createTestRedis());

    expect(await store.checkAndConsume(scope, 100, 500, 200)).toBe('ok');
    expect(await store.checkAndConsume(scope, 100, 500, 200)).toBe('ok');
    expect(await store.checkAndConsume(scope, 100, 500, 200)).toBe('tpm_exceeded');
  });

  it('increments rpm and tpm keys under the scope hash tag', async () => {
    const scope = '{user:rate-keys}';
    const redis = createTestRedis();
    const store = createRateStore(redis);

    await store.checkAndConsume(scope, 10, 1000, 50);

    const minute = Math.floor(Date.now() / 60_000);
    const keys = budgetKeys(scope);
    expect(await redis.get(keys.rpm(minute))).toBe('1');
    expect(await redis.get(keys.tpm(minute))).toBe('50');
  });
});
