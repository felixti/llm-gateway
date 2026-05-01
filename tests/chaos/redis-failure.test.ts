/**
 * Chaos: Redis failure injection.
 *
 * Replaces the happy-path stubs with real failure injection on the shared
 * ioredis client. Asserts that quota/health code paths degrade gracefully
 * (no unhandled rejections, deterministic fallback behavior) when Redis
 * methods reject.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Decimal } from 'decimal.js';
import { redis } from '../../src/db/redis';
import { isRedisHealthy } from '../../src/db/redis';
import { checkAndReserve, getQuotaStatus } from '../../src/services/quota.service';

interface Patch {
  key: string;
  original: unknown;
}

function patchRedis(method: string, replacement: unknown): Patch {
  const r = redis as unknown as Record<string, unknown>;
  const original = r[method];
  r[method] = replacement;
  return { key: method, original };
}

function restoreRedis(patches: Patch[]): void {
  const r = redis as unknown as Record<string, unknown>;
  while (patches.length > 0) {
    const patch = patches.pop();
    if (!patch) continue;
    r[patch.key] = patch.original;
  }
}

describe('Chaos: Redis Failure', () => {
  const patches: Patch[] = [];

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    restoreRedis(patches);
  });

  it('isRedisHealthy() returns false when PING rejects (connection drop)', async () => {
    patches.push(
      patchRedis('ping', async () => {
        throw new Error('ECONNRESET');
      })
    );

    const healthy = await isRedisHealthy();
    expect(healthy).toBe(false);
  });

  it('isRedisHealthy() returns false when PING returns unexpected payload', async () => {
    patches.push(patchRedis('ping', async () => 'NOT-PONG'));
    expect(await isRedisHealthy()).toBe(false);
  });

  it('checkAndReserve() returns {allowed:false} when EVAL rejects', async () => {
    patches.push(
      patchRedis('eval', async () => {
        throw new Error('LOADING Redis is loading the dataset in memory');
      })
    );

    const reservation = await checkAndReserve('chaos-user', new Decimal(0.01));
    expect(reservation.allowed).toBe(false);
    expect(reservation.reason).toMatch(/reservation failed/i);
    expect(reservation.reservationId).toBeUndefined();
  });

  it('getQuotaStatus() degrades to defaults when HGET/GET reject', async () => {
    patches.push(
      patchRedis('hget', async () => {
        throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
      })
    );
    patches.push(
      patchRedis('get', async () => {
        throw new Error('WRONGTYPE');
      })
    );

    // With every read rejecting we fall back to the defaults: zero spent,
    // zero reserved, and hard_limit=true. The default monthly budget (50)
    // remains the public contract even during transient Redis outages.
    const status = await getQuotaStatus('chaos-user');
    expect(status.spent_usd).toBe(0);
    expect(status.reserved_usd).toBe(0);
    expect(status.monthly_budget_usd).toBeGreaterThan(0);
    expect(status.hard_limit).toBe(true);
  });
});
