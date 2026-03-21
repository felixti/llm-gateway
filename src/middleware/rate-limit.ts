/**
 * Rate Limiting Middleware
 * Sliding window rate limiting using Redis sorted sets
 * Enforces RPM (requests per minute) and TPM (tokens per minute) per user
 */

import type { Context, Next } from 'hono';
import { env } from '../config/env';
import { redis } from '../db/redis';
import { errorForProtocol } from '../utils/errors';

// Rate limit constants
const RPM_LIMIT = env.RATE_LIMIT_RPM;
const TPM_LIMIT = env.RATE_LIMIT_TPM;
const WINDOW_SECONDS = 60;

// Header constants
const HEADER_RATE_LIMIT = 'X-RateLimit-Limit';
const HEADER_RATE_REMAINING = 'X-RateLimit-Remaining';
const HEADER_RATE_RESET = 'X-RateLimit-Reset';

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
}

/**
 * Check rate limit for requests (RPM)
 * Uses sliding window with Redis sorted sets
 */
async function checkRequestLimit(userId: string): Promise<RateLimitResult> {
  const key = `ratelimit:rpm:${userId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * 1000;

  // Remove old entries and add current request atomically
  const [, addedCount, count] = await Promise.all([
    redis.zremrangebyscore(key, 0, windowStart),
    redis.zadd(key, now, `${now}:${Math.random()}`),
    redis.zcard(key),
  ]);

  // Set TTL if this is a new key
  if (addedCount > 0) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  const remaining = Math.max(0, RPM_LIMIT - count);
  const allowed = count <= RPM_LIMIT;

  return {
    allowed,
    remaining,
    limit: RPM_LIMIT,
    resetAt: Math.floor((now + WINDOW_SECONDS * 1000) / 1000),
  };
}

/**
 * Check rate limit for tokens (TPM)
 */
async function checkTokenLimit(userId: string, tokenCount: number): Promise<RateLimitResult> {
  const key = `ratelimit:tpm:${userId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * 1000;

  // Get current token count in window and remove old entries
  await redis.zremrangebyscore(key, 0, windowStart);

  // Get current count before adding
  const currentCount = await redis.zcard(key);

  // Calculate new total
  const newTotal = currentCount + tokenCount;
  const allowed = newTotal <= TPM_LIMIT;

  if (allowed) {
    // Add token count to sorted set
    await redis.zadd(key, now, `${now}:${tokenCount}`);
    await redis.expire(key, WINDOW_SECONDS);
  }

  const remaining = Math.max(0, Math.floor(TPM_LIMIT - newTotal));

  return {
    allowed,
    remaining,
    limit: TPM_LIMIT,
    resetAt: Math.floor((now + WINDOW_SECONDS * 1000) / 1000),
  };
}

/**
 * Set rate limit headers on response
 */
function setRateLimitHeaders(c: Context, result: RateLimitResult): void {
  c.header(HEADER_RATE_LIMIT, String(result.limit));
  c.header(HEADER_RATE_REMAINING, String(result.remaining));
  c.header(HEADER_RATE_RESET, String(result.resetAt));
}

/**
 * Get token count from request body
 * Falls back to 0 if not parseable
 */
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

/**
 * Rate limiting middleware
 * Enforces RPM and TPM limits per user
 */
export async function rateLimitMiddleware(c: Context, next: Next): Promise<void> {
  const userId = c.get('userId');

  if (!userId) {
    // No userId means auth middleware hasn't run or failed
    // Let the request pass - auth middleware will handle unauthorized
    await next();
    return;
  }

  // Check RPM limit
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

  // Check TPM limit if token count available
  const tokenCount = extractTokenCount(c);
  if (tokenCount > 0) {
    const tpmResult = await checkTokenLimit(userId, tokenCount);
    // Update remaining based on more restrictive limit
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
