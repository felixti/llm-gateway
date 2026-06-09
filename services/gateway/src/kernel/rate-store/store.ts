import type Redis from 'ioredis';
import { budgetKeys } from '@shared/budget/keys';

export interface RateStore {
  checkAndConsume(
    scope: string,
    rpmLimit: number,
    tpmLimit: number,
    tokens: number,
  ): Promise<'ok' | 'rpm_exceeded' | 'tpm_exceeded'>;
}

const WINDOW_EXPIRE_SEC = 120;

const CHECK_AND_CONSUME_SCRIPT = `
  local rpmKey = KEYS[1]
  local tpmKey = KEYS[2]

  local rpmLimit = tonumber(ARGV[1])
  local tpmLimit = tonumber(ARGV[2])
  local tokens = tonumber(ARGV[3])
  local expireSec = tonumber(ARGV[4])

  local rpm = redis.call('INCR', rpmKey)
  if rpm == 1 then
    redis.call('EXPIRE', rpmKey, expireSec)
  end
  if rpm > rpmLimit then
    redis.call('DECR', rpmKey)
    return {0, 'rpm_exceeded'}
  end

  if tokens > 0 then
    local tpm = redis.call('INCRBY', tpmKey, tokens)
    if tpm == tokens then
      redis.call('EXPIRE', tpmKey, expireSec)
    end
    if tpm > tpmLimit then
      redis.call('DECRBY', tpmKey, tokens)
      return {0, 'tpm_exceeded'}
    end
  end

  return {1, 'ok'}
`;

declare module 'ioredis' {
  interface RedisCommander {
    rateCheckAndConsume(...args: (string | number)[]): Promise<[number, string]>;
  }
}

function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

export function registerRateScripts(redis: Redis): void {
  redis.defineCommand('rateCheckAndConsume', { numberOfKeys: 2, lua: CHECK_AND_CONSUME_SCRIPT });
}

export function createRateStore(redis: Redis): RateStore {
  registerRateScripts(redis);

  return {
    async checkAndConsume(scope, rpmLimit, tpmLimit, tokens) {
      const minute = currentMinute();
      const keys = budgetKeys(scope);
      const [okFlag, status] = await redis.rateCheckAndConsume(
        keys.rpm(minute),
        keys.tpm(minute),
        rpmLimit,
        tpmLimit,
        tokens,
        WINDOW_EXPIRE_SEC,
      );
      if (okFlag === 0 && status === 'rpm_exceeded') return 'rpm_exceeded';
      if (okFlag === 0 && status === 'tpm_exceeded') return 'tpm_exceeded';
      if (okFlag === 1 && status === 'ok') return 'ok';
      throw new Error(`unexpected rate result: ${okFlag}:${status}`);
    },
  };
}
