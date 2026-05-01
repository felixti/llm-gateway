import { redis } from '@/db/redis';
import type { Context, Next } from 'hono';

const CACHE_PREFIX = 'response-cache:';
const DEFAULT_TTL_SECONDS = 60;

interface CacheConfig {
  ttl?: number;
  keyGenerator?: (c: Context) => string;
}

function generateCacheKey(c: Context): string {
  const method = c.req.method;
  const path = c.req.path;
  const query = new URL(c.req.url).search;
  return `${CACHE_PREFIX}${method}:${path}${query}`;
}

export function cacheMiddleware(config: CacheConfig = {}) {
  const ttl = config.ttl || DEFAULT_TTL_SECONDS;
  const keyGenerator = config.keyGenerator || generateCacheKey;

  return async (c: Context, next: Next) => {
    if (c.req.method !== 'GET') {
      await next();
      return;
    }

    const cacheKey = keyGenerator(c);

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = JSON.parse(cached);
        return c.json(data.body, data.status);
      }
    } catch {}

    await next();

    if (c.res.status === 200) {
      try {
        const body = await c.res.clone().json();
        await redis.setex(cacheKey, ttl, JSON.stringify({ body, status: 200 }));
      } catch {}
    }
  };
}
