import { redis } from '@/db/redis';
import { setCircuitBreakerState } from '@/observability/metrics';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT = 30_000;
const CIRCUIT_KEY_PREFIX = 'circuit:';

function getCircuitKey(deploymentName: string): string {
  return `${CIRCUIT_KEY_PREFIX}${deploymentName}`;
}

const RECORD_SUCCESS_SCRIPT = `
  local key = KEYS[1]
  local state = redis.call('hget', key, 'state')
  
  if state == 'HALF_OPEN' then
    redis.call('hset', key, 'state', 'CLOSED', 'failureCount', 0, 'nextAttemptTime', 0)
    return 1
  elseif state == 'CLOSED' or state == false then
    redis.call('hset', key, 'failureCount', 0)
    return 1
  end
  
  return 0
`;

const RECORD_FAILURE_SCRIPT = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local threshold = tonumber(ARGV[2])
  local resetTimeout = tonumber(ARGV[3])
  
  local state = redis.call('hget', key, 'state')
  if state == false then
    state = 'CLOSED'
    redis.call('hset', key, 'state', state, 'failureCount', 0, 'lastFailureTime', 0, 'nextAttemptTime', 0)
  end
  
  local failureCount = tonumber(redis.call('hget', key, 'failureCount') or 0) + 1
  redis.call('hset', key, 'failureCount', failureCount, 'lastFailureTime', now)
  
  if state == 'CLOSED' then
    if failureCount >= threshold then
      redis.call('hset', key, 'state', 'OPEN', 'nextAttemptTime', now + resetTimeout)
      return 2
    end
  elseif state == 'HALF_OPEN' then
    redis.call('hset', key, 'state', 'OPEN', 'nextAttemptTime', now + resetTimeout)
    return 2
  end
  
  return 1
`;

const IS_REQUEST_ALLOWED_SCRIPT = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local resetTimeout = tonumber(ARGV[2])
  
  local state = redis.call('hget', key, 'state')
  if state == false or state == 'CLOSED' then
    return 1
  end
  
  if state == 'OPEN' then
    local nextAttemptTime = tonumber(redis.call('hget', key, 'nextAttemptTime') or 0)
    if now >= nextAttemptTime then
      redis.call('hset', key, 'state', 'HALF_OPEN')
      return 1
    end
    return 0
  end
  
  if state == 'HALF_OPEN' then
    return 1
  end
  
  return 0
`;

export async function recordSuccess(deploymentName: string): Promise<void> {
  const key = getCircuitKey(deploymentName);
  await redis.eval(RECORD_SUCCESS_SCRIPT, 1, key);
  const state = await redis.hget(key, 'state');
  if (state) {
    setCircuitBreakerState(state as 'CLOSED' | 'OPEN' | 'HALF_OPEN');
  }
}

export async function recordFailure(deploymentName: string): Promise<void> {
  const key = getCircuitKey(deploymentName);
  await redis.eval(
    RECORD_FAILURE_SCRIPT,
    1,
    key,
    Date.now(),
    DEFAULT_FAILURE_THRESHOLD,
    DEFAULT_RESET_TIMEOUT
  );
  const state = await redis.hget(key, 'state');
  if (state) {
    setCircuitBreakerState(state as 'CLOSED' | 'OPEN' | 'HALF_OPEN');
  }
}

export async function isRequestAllowed(deploymentName: string): Promise<boolean> {
  const key = getCircuitKey(deploymentName);
  const result = await redis.eval(
    IS_REQUEST_ALLOWED_SCRIPT,
    1,
    key,
    Date.now(),
    DEFAULT_RESET_TIMEOUT
  );
  return result === 1;
}

export async function getCircuitState(deploymentName: string): Promise<{
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
  nextAttemptTime: number | null;
}> {
  const key = getCircuitKey(deploymentName);
  const data = await redis.hgetall(key);

  if (!data || Object.keys(data).length === 0) {
    return {
      state: CircuitState.CLOSED,
      failureCount: 0,
      lastFailureTime: null,
      nextAttemptTime: null,
    };
  }

  const state = (data.state as CircuitState) || CircuitState.CLOSED;

  return {
    state,
    failureCount: Number(data.failureCount || 0),
    lastFailureTime: data.lastFailureTime ? Number(data.lastFailureTime) : null,
    nextAttemptTime:
      data.nextAttemptTime && Number(data.nextAttemptTime) !== 0
        ? Number(data.nextAttemptTime)
        : null,
  };
}

export async function resetCircuitBreaker(deploymentName: string): Promise<void> {
  const key = getCircuitKey(deploymentName);
  await redis.del(key);
}

export async function resetAllCircuitBreakers(): Promise<void> {
  const pattern = `${CIRCUIT_KEY_PREFIX}*`;
  let cursor = '0';

  do {
    const [newCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = newCursor;

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
}
