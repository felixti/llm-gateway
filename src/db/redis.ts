import { env } from '@/config/env';
import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

const redisOptions: RedisOptions = {
  host: env.REDIS_HOST || 'localhost',
  port: env.REDIS_PORT || 6379,
  retryStrategy: (times: number) => Math.min(times * 50, 2000),
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: true,
};

if (env.REDIS_PASSWORD) {
  redisOptions.password = env.REDIS_PASSWORD;
}

export const redis = new Redis(redisOptions);

redis.on('connect', () => console.log('Redis client connected'));
redis.on('ready', () => console.log('Redis client ready'));
redis.on('error', (err) => console.error('Redis client error:', err));
redis.on('close', () => console.log('Redis client connection closed'));

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
