import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import '../types';
import { rateLimitMiddleware } from './rate-limit';
import type { RateStore } from '../kernel/rate-store/store';

function mockRateStore(result: 'ok' | 'rpm_exceeded' | 'tpm_exceeded'): RateStore {
  return { checkAndConsume: vi.fn().mockResolvedValue(result) };
}

function app(rateStore: RateStore) {
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
    c.set('parsedBody', { model: 'gpt-5.4', messages: [] });
    c.set('family', 'openai-chat');
    await next();
  });
  a.post('/x', rateLimitMiddleware({ rateStore, rpmLimit: 10, tpmLimit: 10_000 }), (c) =>
    c.json({ ok: true }),
  );
  return a;
}

describe('rateLimitMiddleware', () => {
  it('passes when under limit', async () => {
    const store = mockRateStore('ok');
    const res = await app(store).request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(store.checkAndConsume).toHaveBeenCalledWith('{proj:proj1}', 10, 10_000, expect.any(Number));
  });

  it('returns 429 on rpm_exceeded', async () => {
    const res = await app(mockRateStore('rpm_exceeded')).request('/x', { method: 'POST' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limit_exceeded', type: 'rpm_exceeded' });
  });

  it('returns 429 on tpm_exceeded', async () => {
    const res = await app(mockRateStore('tpm_exceeded')).request('/x', { method: 'POST' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limit_exceeded', type: 'tpm_exceeded' });
  });
});
