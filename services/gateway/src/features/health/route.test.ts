import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, it, expect } from 'vitest';
import { createApp } from '../../app';
import { createBudgetStore } from '../../kernel/budget-store/store';
import { createMemoryConfigStore } from '../../kernel/config-store/memory-store';
import { createRateStore } from '../../kernel/rate-store/store';

const redis = new RedisMock({ data: {} }) as unknown as Redis;

const deps = {
  auth: { orgId: 'internal', m2m: { jwks: (async () => { throw new Error('unused'); }) as never, issuer: 'i', audience: 'a', appId: 'x' } },
  configStore: createMemoryConfigStore(),
  budgetStore: createBudgetStore(redis),
  rateStore: createRateStore(redis),
  redis,
  rateLimitRpm: 100,
  rateLimitTpm: 100_000,
  reservationTtlSec: 300,
  reserveMultiplier: 1.2,
  commitIdempotencyTtlSec: 604_800,
};

describe('health', () => {
  it('GET /health → 200 ok', async () => {
    const res = await createApp(deps).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
