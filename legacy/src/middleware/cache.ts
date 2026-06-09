import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
import type { Context, Next } from 'hono';

const CACHE_PREFIX = 'response-cache:';
const DEFAULT_TTL_SECONDS = 60;

interface CacheConfig {
  ttl?: number;
  keyGenerator?: (c: Context) => string;
}

interface CachedResponse {
  body: string;
  status: number;
  headers?: Record<string, string>;
}

function generateCacheKey(c: Context): string {
  const userId = (c.get('userId') as string | undefined) || 'anonymous';
  const method = c.req.method;
  const path = c.req.path;
  const query = new URL(c.req.url).search;
  return `${CACHE_PREFIX}${userId}:${method}:${path}${query}`;
}

// Per-request or sensitive headers MUST NOT be persisted in the shared cache;
// otherwise a replay could leak Set-Cookie / Authorization across users or
// cause stale tracing IDs to surface on later requests.
const NON_CACHEABLE_HEADERS = new Set([
  'set-cookie',
  'authorization',
  'x-request-id',
  'x-quota-reserved',
]);

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (NON_CACHEABLE_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

function withAuthorizationVary(headers: ConstructorParameters<typeof Headers>[0]): Headers {
  const result = new Headers(headers);
  const vary = result.get('Vary');
  if (!vary) {
    result.set('Vary', 'Authorization');
    return result;
  }

  const values = vary.split(',').map((value) => value.trim().toLowerCase());
  if (!values.includes('authorization')) {
    result.set('Vary', `${vary}, Authorization`);
  }
  return result;
}

function createCachedResponse(data: CachedResponse): Response {
  return new Response(data.body, {
    status: data.status,
    headers: withAuthorizationVary(data.headers),
  });
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
        const data = JSON.parse(cached) as CachedResponse;
        if (typeof data.body === 'string') {
          return createCachedResponse(data);
        }
      }
    } catch (error) {
      logger.warn({ cacheKey, error }, 'Cache read/parse error');
    }

    await next();

    if (c.res.status === 200) {
      try {
        c.res.headers.set(
          'Vary',
          withAuthorizationVary(c.res.headers).get('Vary') ?? 'Authorization'
        );
        const body = await c.res.clone().text();
        await redis.setex(
          cacheKey,
          ttl,
          JSON.stringify({
            body,
            status: c.res.status,
            headers: headersToObject(c.res.headers),
          })
        );
      } catch (error) {
        logger.warn({ cacheKey, error }, 'Cache write error');
      }
    }
  };
}
