import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
import type { Context, Next } from 'hono';

const CACHE_PREFIX = 'response-cache:';
const DEFAULT_TTL_SECONDS = 60;

interface CacheConfig {
  ttl?: number;
  keyGenerator?: (c: Context) => string;
}

function generateCacheKey(c: Context): string {
  const userId = (c.get('userId') as string | undefined) || 'anonymous';
  const method = c.req.method;
  const path = c.req.path;
  const query = new URL(c.req.url).search;
  return `${CACHE_PREFIX}${userId}:${method}:${path}${query}`;
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
        if (typeof data.body === 'string') {
          return new Response(data.body, {
            status: data.status,
          });
        }
        const response = c.json(data.body, data.status);
        return response;
      }
    } catch (error) {
      logger.warn({ cacheKey, error }, 'Cache read/parse error');
    }

    await next();

    if (c.res.status === 200) {
      try {
        const body = await c.res.clone().text();
        await redis.setex(cacheKey, ttl, JSON.stringify({ body, status: c.res.status }));
      } catch (error) {
        logger.warn({ cacheKey, error }, 'Cache write error');
      }
    }
  };
}
