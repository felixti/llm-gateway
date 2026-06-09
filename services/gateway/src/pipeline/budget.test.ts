import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import '../types';
import { budgetMiddleware } from './budget';
import { createBudgetStore } from '../kernel/budget-store/store';
import { createMemoryConfigStore } from '../kernel/config-store/memory-store';
import { syncBudgetPolicy } from '../kernel/policy-sync';
import type { BudgetStore } from '../kernel/budget-store/store';

function createTestRedis(): Redis {
  return new RedisMock({ data: {} }) as unknown as Redis;
}

function app(deps: { budgetStore: BudgetStore; redis: Redis }) {
  const configStore = createMemoryConfigStore();
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('tenantContext', {
      principalId: 'app1',
      principalKind: 'sp',
      projectId: 'proj1',
      orgId: 'internal',
      modelAllowlist: ['gpt-5.4'],
      budgetPolicy: {
        principalId: 'proj1',
        scopeKind: 'project',
        capUsd: '100.000000',
        period: 'monthly',
        hard: true,
      },
    });
    c.set('model', 'gpt-5.4');
    c.set('parsedBody', { model: 'gpt-5.4', messages: [] });
    c.set('family', 'openai-chat');
    await next();
  });
  a.post(
    '/x',
    budgetMiddleware({
      budgetStore: deps.budgetStore,
      configStore,
      redis: deps.redis,
      reservationTtlSec: 300,
      reserveMultiplier: 1.2,
    }),
    (c) =>
      c.json({
        reservationId: c.get('reservationId'),
        budgetScope: c.get('budgetScope'),
        reservedMicro: c.get('reservedMicro').toString(),
      }),
  );
  return a;
}

describe('budgetMiddleware', () => {
  const scope = '{proj:proj1}';
  let redis: Redis;
  let budgetStore: BudgetStore;

  beforeEach(async () => {
    redis = createTestRedis();
    budgetStore = createBudgetStore(redis);
    await syncBudgetPolicy(redis, scope, {
      principalId: 'proj1',
      scopeKind: 'project',
      capUsd: '100.000000',
      period: 'monthly',
      hard: true,
    });
    await redis.set(`${scope}:spent`, '0');
    await redis.set(`${scope}:reserved`, '0');
  });

  it('reserves budget and sets context vars', async () => {
    const res = await app({ budgetStore, redis }).request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.budgetScope).toBe(scope);
    expect(body.reservationId).toBeTruthy();
    expect(BigInt(body.reservedMicro)).toBeGreaterThan(0n);
  });

  it('returns 429 when over cap', async () => {
    await redis.set(`${scope}:spent`, '999999999');
    const res = await app({ budgetStore, redis }).request('/x', { method: 'POST' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'insufficient_quota' });
  });

  it('returns 403 when budget policy missing', async () => {
    const a = new Hono();
    a.use('*', async (c, next) => {
      c.set('tenantContext', {
        principalId: 'app1',
        principalKind: 'sp',
        projectId: 'proj1',
        orgId: 'internal',
        modelAllowlist: ['gpt-5.4'],
        budgetPolicy: null,
      });
      c.set('model', 'gpt-5.4');
      c.set('parsedBody', { model: 'gpt-5.4', messages: [] });
      c.set('family', 'openai-chat');
      await next();
    });
    a.post(
      '/x',
      budgetMiddleware({
        budgetStore,
        configStore: createMemoryConfigStore(),
        redis,
        reservationTtlSec: 300,
        reserveMultiplier: 1.2,
      }),
      (c) => c.json({ ok: true }),
    );
    const res = await a.request('/x', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when model config missing', async () => {
    const a = new Hono();
    a.use('*', async (c, next) => {
      c.set('tenantContext', {
        principalId: 'app1',
        principalKind: 'sp',
        projectId: 'proj1',
        orgId: 'internal',
        modelAllowlist: ['unknown-model'],
        budgetPolicy: {
          principalId: 'proj1',
          scopeKind: 'project',
          capUsd: '100.000000',
          period: 'monthly',
          hard: true,
        },
      });
      c.set('model', 'unknown-model');
      c.set('parsedBody', { model: 'unknown-model', messages: [] });
      c.set('family', 'openai-chat');
      await next();
    });
    const configStore = { getModel: vi.fn().mockResolvedValue(null) } as never;
    a.post(
      '/x',
      budgetMiddleware({
        budgetStore,
        configStore,
        redis,
        reservationTtlSec: 300,
        reserveMultiplier: 1.2,
      }),
      (c) => c.json({ ok: true }),
    );
    const res = await a.request('/x', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});
