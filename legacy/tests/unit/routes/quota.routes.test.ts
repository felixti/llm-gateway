import { beforeEach, describe, expect, it, vi } from 'bun:test';
import { Hono } from 'hono';
import { quotaRoutes } from '@/routes/quota.routes';
import * as quotaService from '@/services/quota.service';
import { redis } from '@/db/redis';
import { MockRedis } from '../../integration/helpers/mock-redis';
import { createTestPat } from '../../integration/helpers/test-pat';

interface ErrorResponseBody {
  error?: unknown;
}

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
}

describe('quota.routes - error paths', () => {
  beforeEach(() => {
    bindMockRedis(new MockRedis());
  });

  function createApp(): Hono {
    const app = new Hono();
    app.route('/quota', quotaRoutes);
    return app;
  }

  it('returns 500 when getQuotaStatus throws', async () => {
    const spy = vi.spyOn(quotaService, 'getQuotaStatus').mockRejectedValue(new Error('redis down'));
    const app = createApp();
    const pat = createTestPat('user-err');
    const res = await app.request('/quota', {
      headers: { Authorization: pat },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBeDefined();
    spy.mockRestore();
  });
});
