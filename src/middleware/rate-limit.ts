import { env } from '@/config/env';
import { redis } from '@/db/redis';
import { errorForProtocol } from '@/utils/errors';
import type { Context, Next } from 'hono';

const RPM_LIMIT = env.RATE_LIMIT_RPM;
const TPM_LIMIT = env.RATE_LIMIT_TPM;
const WINDOW_SECONDS = 60;
const MS_PER_SECOND = 1000;

const HEADER_RATE_LIMIT = 'X-RateLimit-Limit';
const HEADER_RATE_REMAINING = 'X-RateLimit-Remaining';
const HEADER_RATE_RESET = 'X-RateLimit-Reset';

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
}

const CHECK_REQUEST_LIMIT_SCRIPT = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowStart = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local windowSeconds = tonumber(ARGV[4])
  
  redis.call('zremrangebyscore', key, 0, windowStart)
  local count = redis.call('zcard', key)
  
  if count >= limit then
    return {0, count}
  end
  
  local member = now .. ':' .. math.random()
  redis.call('zadd', key, now, member)
  redis.call('expire', key, windowSeconds)
  
  return {1, count + 1}
`;

const CHECK_TOKEN_LIMIT_SCRIPT = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowStart = tonumber(ARGV[2])
  local tokenCount = tonumber(ARGV[3])
  local limit = tonumber(ARGV[4])
  local windowSeconds = tonumber(ARGV[5])
  
  redis.call('zremrangebyscore', key, 0, windowStart)
  local entries = redis.call('zrange', key, 0, -1, 'WITHSCORES')
  local total = 0
  
  for i = 1, #entries, 2 do
    local tokens = tonumber(entries[i]:match(':(%d+)$') or 0)
    total = total + tokens
  end
  
  if total + tokenCount > limit then
    return {0, total}
  end
  
  local member = now .. ':' .. tokenCount
  redis.call('zadd', key, now, member)
  redis.call('expire', key, windowSeconds)
  
  return {1, total + tokenCount}
`;

async function checkRequestLimit(userId: string): Promise<RateLimitResult> {
  const key = `ratelimit:rpm:${userId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * MS_PER_SECOND;

  const result = await redis.eval(
    CHECK_REQUEST_LIMIT_SCRIPT,
    1,
    key,
    now,
    windowStart,
    RPM_LIMIT,
    WINDOW_SECONDS
  );

  const [allowed, count] = result as [number, number];
  const remaining = Math.max(0, RPM_LIMIT - count);

  return {
    allowed: allowed === 1,
    remaining,
    limit: RPM_LIMIT,
    resetAt: Math.floor((now + WINDOW_SECONDS * MS_PER_SECOND) / MS_PER_SECOND),
  };
}

async function checkTokenLimit(userId: string, tokenCount: number): Promise<RateLimitResult> {
  const key = `ratelimit:tpm:${userId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * MS_PER_SECOND;

  const result = await redis.eval(
    CHECK_TOKEN_LIMIT_SCRIPT,
    1,
    key,
    now,
    windowStart,
    tokenCount,
    TPM_LIMIT,
    WINDOW_SECONDS
  );

  const [allowed, total] = result as [number, number];
  const remaining = Math.max(0, Math.floor(TPM_LIMIT - total));

  return {
    allowed: allowed === 1,
    remaining,
    limit: TPM_LIMIT,
    resetAt: Math.floor((now + WINDOW_SECONDS * MS_PER_SECOND) / MS_PER_SECOND),
  };
}

function setRateLimitHeaders(c: Context, result: RateLimitResult): void {
  c.header(HEADER_RATE_LIMIT, String(result.limit));
  c.header(HEADER_RATE_REMAINING, String(result.remaining));
  c.header(HEADER_RATE_RESET, String(result.resetAt));
}

function extractTokenCount(c: Context): number {
  const body = c.get('parsedBody');
  if (body && typeof body === 'object' && body !== null) {
    const b = body as { max_tokens?: number };
    if (typeof b.max_tokens === 'number' && b.max_tokens > 0) {
      return b.max_tokens;
    }
  }
  return 0;
}

export async function rateLimitMiddleware(c: Context, next: Next): Promise<void> {
  const userId = c.get('userId');

  if (!userId) {
    await next();
    return;
  }

  const rpmResult = await checkRequestLimit(userId);
  setRateLimitHeaders(c, rpmResult);

  if (!rpmResult.allowed) {
    const error = errorForProtocol(
      c.req.path,
      429,
      'rate_limit_exceeded',
      'Rate limit exceeded. Please retry later.'
    );
    c.status(429);
    c.json(error);
    return;
  }

  const tokenCount = extractTokenCount(c);
  if (tokenCount > 0) {
    const tpmResult = await checkTokenLimit(userId, tokenCount);
    if (!tpmResult.allowed) {
      const error = errorForProtocol(
        c.req.path,
        429,
        'rate_limit_exceeded',
        'Token rate limit exceeded. Please retry later.'
      );
      c.status(429);
      c.json(error);
      return;
    }
  }

  await next();
}
