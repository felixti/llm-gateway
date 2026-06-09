import { env } from '@/config/env';
import { logger } from '@/observability/logger';
import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

const isTest = process.env.NODE_ENV === 'test';

let redisOptions: RedisOptions;

if (env.REDIS_URL) {
  redisOptions = {
    retryStrategy: (times: number) => Math.min(times * 50, 2000),
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    lazyConnect: isTest,
  };
} else {
  redisOptions = {
    host: env.REDIS_HOST || 'localhost',
    port: env.REDIS_PORT || 6379,
    retryStrategy: (times: number) => Math.min(times * 50, 2000),
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    lazyConnect: isTest,
  };
}

if (env.REDIS_PASSWORD) {
  redisOptions.password = env.REDIS_PASSWORD;
}

export const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, redisOptions)
  : new Redis(redisOptions);

if (!isTest) {
  redis.on('connect', () => logger.info('Redis client connected'));
  redis.on('ready', () => logger.info('Redis client ready'));
  redis.on('error', (err) => logger.error({ err }, 'Redis client error'));
  redis.on('close', () => logger.info('Redis client connection closed'));
} else {
  // Swallow connection errors in tests; methods are mocked by helpers.
  redis.on('error', () => {});
}

export async function isRedisHealthy(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
