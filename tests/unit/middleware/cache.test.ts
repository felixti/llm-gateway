import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { redis } from '@/db/redis';
import { cacheMiddleware } from '@/middleware/cache';
import { MockRedis } from '../../integration/helpers/mock-redis';

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as Record<string, unknown>;
  r.get = mock.get.bind(mock);
  r.set = mock.set.bind(mock);
  r.setex = mock.setex.bind(mock);
}

describe('cacheMiddleware', () => {
  beforeEach(() => {
    bindMockRedis(new MockRedis());
  });

  afterEach(() => {});

  test('two different users do not share cache hits', async () => {
    const app = new Hono();
    let requestCount = 0;

    app.use('*', async (c, next) => {
      const testUser = c.req.header('x-test-user');
      if (testUser) {
        c.set('userId', testUser);
      }
      await next();
    });

    app.use('/models', cacheMiddleware({ ttl: 60 }));
    app.get('/models', (c) => {
      requestCount++;
      return c.json({ requestCount, userId: c.get('userId') });
    });

    const resUserA = await app.request('/models', {
      headers: { 'x-test-user': 'user-a' },
    });
    expect(resUserA.status).toBe(200);
    const bodyA = (await resUserA.json()) as { requestCount: number; userId: string };
    expect(bodyA.requestCount).toBe(1);
    expect(bodyA.userId).toBe('user-a');

    const resUserAAgain = await app.request('/models', {
      headers: { 'x-test-user': 'user-a' },
    });
    expect(resUserAAgain.status).toBe(200);
    const bodyAAgain = (await resUserAAgain.json()) as { requestCount: number; userId: string };
    expect(bodyAAgain.requestCount).toBe(1);

    const resUserB = await app.request('/models', {
      headers: { 'x-test-user': 'user-b' },
    });
    expect(resUserB.status).toBe(200);
    const bodyB = (await resUserB.json()) as { requestCount: number; userId: string };
    expect(bodyB.requestCount).toBe(2);
    expect(bodyB.userId).toBe('user-b');
  });
});
