import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  startHealthChecks,
  stopHealthChecks,
  getCachedDeploymentHealth,
  resetHealthCacheForTests,
  checkDeploymentHealth,
  getDeploymentHealth,
  getAllDeploymentHealth,
  type DeploymentHealth,
} from '@/services/health.service';
import { redis } from '@/db/redis';
import type { DeploymentConfig } from '@/config/deployments';

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

describe('health.service - extended coverage', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetHealthCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    stopHealthChecks();
    resetHealthCacheForTests();
  });

  describe('checkDeploymentHealth - anthropic protocol', () => {
    it('uses Foundry /models GET for anthropic-messages deployments', async () => {
      const anthropicDeployment: DeploymentConfig = {
        ...deployment,
        name: 'claude-opus-4-6',
        modelFamily: 'claude',
        protocolFamily: 'anthropic-messages',
        endpoint: 'https://example.foundry.azure.com',
        azureModelName: 'claude-opus-4-6',
      };

      let capturedUrl = '';
      let capturedMethod = '';
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          capturedMethod = init?.method ?? 'GET';
          return new Response('{}', { status: 200 });
        },
        { preconnect: originalFetch.preconnect }
      ) as typeof fetch;

      const health = await checkDeploymentHealth(anthropicDeployment);
      expect(health.healthy).toBe(true);
      expect(health.deploymentName).toBe('claude-opus-4-6');
      expect(capturedUrl).toContain('/models');
      expect(capturedMethod).toBe('GET');
    });
  });

  describe('checkDeploymentHealth - error paths', () => {
    it('returns unhealthy when upstream returns non-ok status', async () => {
      globalThis.fetch = Object.assign(
        async () => new Response('error', { status: 500 }),
        { preconnect: originalFetch.preconnect }
      ) as typeof fetch;

      const health = await checkDeploymentHealth(deployment);
      expect(health.healthy).toBe(false);
      expect(health.error).toContain('500');
    });

    it('returns unhealthy when upstream throws', async () => {
      globalThis.fetch = Object.assign(
        async () => { throw new Error('timeout'); },
        { preconnect: originalFetch.preconnect }
      ) as typeof fetch;

      const health = await checkDeploymentHealth(deployment);
      expect(health.healthy).toBe(false);
      expect(health.error).toBe('timeout');
    });
  });

  describe('getDeploymentHealth', () => {
    it('returns null for unknown deployment', async () => {
      const result = await getDeploymentHealth('nonexistent-deployment-xyz');
      expect(result).toBeNull();
    });

    it('returns unhealthy when deployments disabled', async () => {
      const origVal = process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = 'false';

      const result = await getDeploymentHealth('gpt-5.4');
      if (result) {
        expect(result.healthy).toBe(false);
      }

      if (origVal === undefined) {
        delete process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      } else {
        process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = origVal;
      }
    });
  });

  describe('startHealthChecks / stopHealthChecks', () => {
    it('startHealthChecks does nothing when HEALTH_CHECK_ENABLED is false', () => {
      const origVal = process.env.HEALTH_CHECK_ENABLED;
      process.env.HEALTH_CHECK_ENABLED = 'false';
      resetHealthCacheForTests();
      stopHealthChecks();

      startHealthChecks();
      expect(getCachedDeploymentHealth().size).toBe(0);

      if (origVal === undefined) {
        delete process.env.HEALTH_CHECK_ENABLED;
      } else {
        process.env.HEALTH_CHECK_ENABLED = origVal;
      }
    });

    it('startHealthChecks does nothing when HEALTH_CHECK_DEPLOYMENTS_ENABLED is false', () => {
      const origVal = process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = 'false';
      resetHealthCacheForTests();
      stopHealthChecks();

      startHealthChecks();
      expect(getCachedDeploymentHealth().size).toBe(0);

      if (origVal === undefined) {
        delete process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      } else {
        process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = origVal;
      }
    });

    it('startHealthChecks does not start duplicate intervals', () => {
      const origEnabled = process.env.HEALTH_CHECK_ENABLED;
      const origDeployments = process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      process.env.HEALTH_CHECK_ENABLED = 'true';
      process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = 'true';

      stopHealthChecks();
      startHealthChecks();
      startHealthChecks();
      stopHealthChecks();

      if (origEnabled === undefined) delete process.env.HEALTH_CHECK_ENABLED;
      else process.env.HEALTH_CHECK_ENABLED = origEnabled;
      if (origDeployments === undefined) delete process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      else process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = origDeployments;
    });

    it('stopHealthChecks is a no-op when no interval is running', () => {
      stopHealthChecks();
      stopHealthChecks();
    });
  });

  describe('getAllDeploymentHealth', () => {
    it('returns empty cache when deployments are disabled', async () => {
      const origVal = process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = 'false';
      resetHealthCacheForTests();

      const result = await getAllDeploymentHealth();
      expect(result.size).toBe(0);

      if (origVal === undefined) {
        delete process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED;
      } else {
        process.env.HEALTH_CHECK_DEPLOYMENTS_ENABLED = origVal;
      }
    });
  });
});
