import Redis from 'ioredis';

export function createRedis(url?: string): Redis {
  const redisUrl = url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  return new Redis(redisUrl);
}
