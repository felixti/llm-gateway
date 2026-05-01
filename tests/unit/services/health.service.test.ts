import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { DeploymentConfig } from '@/config/deployments';
import { redis } from '@/db/redis';
import {
  checkDeploymentHealth,
  getAllDeploymentHealth,
  getCachedDeploymentHealth,
  resetHealthCacheForTests,
} from '@/services/health.service';

const deployment: DeploymentConfig = {
  name: 'gpt-5.4-global',
  modelAlias: 'gpt-5.4',
  modelFamily: 'gpt',
  protocolFamily: 'chat-completions',
  azureModelName: 'gpt-5.4',
  endpoint: 'https://example.openai.azure.com',
  authConfig: { type: 'api-key', apiKey: 'test-key', keyHeader: 'api-key' },
  apiVersion: '2024-06-01',
  enabled: true,
};

describe('checkDeploymentHealth', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEval: typeof redis.eval;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEval = redis.eval.bind(redis) as typeof redis.eval;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    redis.eval = originalEval;
  });

  it('awaits and catches circuit-breaker writes when health checks fail', async () => {
    const failingFetch = async () => {
      throw new Error('network down');
    };
    globalThis.fetch = Object.assign(failingFetch, {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;

    redis.eval = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error('redis down');
    }) as typeof redis.eval;

    const start = performance.now();
    const health = await checkDeploymentHealth(deployment);

    expect(performance.now() - start).toBeGreaterThanOrEqual(20);
    expect(health.healthy).toBe(false);
    expect(health.error).toBe('network down');
  });
});

describe('health cache', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetHealthCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetHealthCacheForTests();
  });

  it('starts empty and is populated after a probe sweep', async () => {
    // All upstream probes resolve 200 so every deployment looks healthy.
    globalThis.fetch = Object.assign(
      async () => new Response('{}', { status: 200 }),
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    expect(getCachedDeploymentHealth().size).toBe(0);

    const fresh = await getAllDeploymentHealth();
    const cached = getCachedDeploymentHealth();

    expect(cached.size).toBe(fresh.size);
    expect(cached.size).toBeGreaterThan(0);
    for (const [name, probe] of fresh) {
      expect(cached.get(name)?.healthy).toBe(probe.healthy);
    }
  });
});
