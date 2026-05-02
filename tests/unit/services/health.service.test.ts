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

const foundryDeployment: DeploymentConfig = {
  name: 'kimi-k2.5',
  modelAlias: 'kimi-k2.5',
  modelFamily: 'kimi',
  protocolFamily: 'chat-completions',
  azureModelName: 'FW-Kimi-K2.5',
  endpoint: 'https://example.foundry.azure.com',
  authConfig: { type: 'api-key', apiKey: 'test-foundry-key', keyHeader: 'api-key' },
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

  it('uses Azure OpenAI path for gpt deployments', async () => {
    let capturedUrl = '';
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, _init?: RequestInit) => {
        capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        return new Response('{}', { status: 200 });
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    redis.eval = (async () => 'OK') as typeof redis.eval;

    await checkDeploymentHealth(deployment);

    const url = new URL(capturedUrl);
    expect(url.pathname).toBe('/openai/deployments/gpt-5.4-global/chat/completions');
  });

  it('uses Foundry /models path for kimi deployments', async () => {
    let capturedUrl = '';
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, _init?: RequestInit) => {
        capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        return new Response('{}', { status: 200 });
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    redis.eval = (async () => 'OK') as typeof redis.eval;

    await checkDeploymentHealth(foundryDeployment);

    const url = new URL(capturedUrl);
    expect(url.pathname).toBe('/models/chat/completions');
  });

  it('sends azureModelName for Foundry chat-completions health probes', async () => {
    let capturedBody = '';
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return new Response('{}', { status: 200 });
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    redis.eval = (async () => 'OK') as typeof redis.eval;

    await checkDeploymentHealth(foundryDeployment);

    const body = JSON.parse(capturedBody);
    expect(body.model).toBe('FW-Kimi-K2.5');
  });

  it('sends deployment.name for non-Foundry health probes', async () => {
    let capturedBody = '';
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return new Response('{}', { status: 200 });
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    redis.eval = (async () => 'OK') as typeof redis.eval;

    await checkDeploymentHealth(deployment);

    const body = JSON.parse(capturedBody);
    expect(body.model).toBe('gpt-5.4-global');
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
