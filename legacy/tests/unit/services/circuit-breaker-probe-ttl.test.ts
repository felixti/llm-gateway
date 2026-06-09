import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MockRedis } from '../../integration/helpers/mock-redis';
import { redis } from '../../../src/db/redis';
import {
  IS_REQUEST_ALLOWED_SCRIPT,
  PROBE_TTL_SECONDS,
  isRequestAllowed,
  resetCircuitBreaker,
} from '../../../src/services/circuit-breaker';

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as Record<string, unknown>;
  r.get = mock.get.bind(mock);
  r.set = mock.set.bind(mock);
  r.eval = mock.eval.bind(mock);
  r.hget = mock.hget.bind(mock);
  r.hgetall = mock.hgetall.bind(mock);
  r.hset = mock.hset.bind(mock);
  r.del = mock.del.bind(mock);
  r.ttl = mock.ttl.bind(mock);
  r.scan = mock.scan.bind(mock);
}

describe('Circuit breaker probe key TTL', () => {
  const dep = 'test-deployment-ttl';

  beforeEach(() => {
    bindMockRedis(new MockRedis());
  });

  afterEach(async () => {
    await resetCircuitBreaker(dep);
  });

  test('PROBE_TTL_SECONDS is reasonable (>= REQUEST_TIMEOUT_MS in seconds + buffer)', () => {
    expect(PROBE_TTL_SECONDS).toBeGreaterThanOrEqual(35);
    expect(PROBE_TTL_SECONDS).toBeLessThan(600);
  });

  test('IS_REQUEST_ALLOWED_SCRIPT applies EX TTL on OPEN→HALF_OPEN probe set', () => {
    expect(IS_REQUEST_ALLOWED_SCRIPT).toContain("'set', probeKey, '1', 'EX', probeTtl");
  });

  test('IS_REQUEST_ALLOWED_SCRIPT applies EX TTL on HALF_OPEN NX probe set', () => {
    expect(IS_REQUEST_ALLOWED_SCRIPT).toContain(
      "'set', probeKey, '1', 'NX', 'EX', probeTtl"
    );
  });

  test('IS_REQUEST_ALLOWED_SCRIPT does not contain bare set probeKey without EX', () => {
    const matches = IS_REQUEST_ALLOWED_SCRIPT.match(/'set',\s*probeKey,\s*'1'(?!,\s*'(?:NX|EX))/g);
    expect(matches).toBeNull();
  });

  test('OPEN→HALF_OPEN transition uses Lua script with probeTtl ARGV', async () => {
    expect(IS_REQUEST_ALLOWED_SCRIPT).toContain('local probeTtl = tonumber(ARGV[3])');
  });

  test('Probe rejection still works: second concurrent probe is rejected', async () => {
    const mock = new MockRedis();
    bindMockRedis(mock);
    await mock.hset(`circuit:${dep}`, { state: 'HALF_OPEN', failureCount: '5' });

    const first = await isRequestAllowed(dep);
    expect(first).toBe(true);

    const second = await isRequestAllowed(dep);
    expect(second).toBe(false);
  });
});
