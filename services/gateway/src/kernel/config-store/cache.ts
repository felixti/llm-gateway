import type { BudgetPolicy, ModelConfig, PrincipalRecord } from '@shared/contracts/tenant';
import type { ConfigStore } from './types';

const DEFAULT_TTL_MS = 60_000;

type CacheEntry = {
  value: unknown;
  expiresAt: number;
};

function modelKey(alias: string): string {
  return `model:${alias}`;
}

function principalKey(principalId: string): string {
  return `principal:${principalId}`;
}

function budgetKey(principalId: string, scopeKind: 'user' | 'project'): string {
  return `budget:${principalId}:${scopeKind}`;
}

const MODELS_KEY = 'models';

export function createCachedConfigStore(
  underlying: ConfigStore,
  opts?: { ttlMs?: number },
): ConfigStore {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, CacheEntry>();
  let lastSeenVersion: number | null = null;

  async function bustIfVersionChanged(): Promise<void> {
    const version = await underlying.getConfigVersion();
    if (lastSeenVersion !== null && lastSeenVersion !== version) {
      cache.clear();
    }
    lastSeenVersion = version;
  }

  function getCached<T>(key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  function setCached(key: string, value: unknown): void {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  return {
    async getModel(alias) {
      await bustIfVersionChanged();
      const key = modelKey(alias);
      const cached = getCached<ModelConfig | null>(key);
      if (cached !== undefined) {
        return cached;
      }
      const value = await underlying.getModel(alias);
      setCached(key, value);
      return value;
    },

    async listModels() {
      await bustIfVersionChanged();
      const cached = getCached<ModelConfig[]>(MODELS_KEY);
      if (cached !== undefined) {
        return cached;
      }
      const value = await underlying.listModels();
      setCached(MODELS_KEY, value);
      return value;
    },

    async getPrincipal(principalId) {
      await bustIfVersionChanged();
      const key = principalKey(principalId);
      const cached = getCached<PrincipalRecord | null>(key);
      if (cached !== undefined) {
        return cached;
      }
      const value = await underlying.getPrincipal(principalId);
      setCached(key, value);
      return value;
    },

    async getBudgetPolicy(principalId, scopeKind) {
      await bustIfVersionChanged();
      const key = budgetKey(principalId, scopeKind);
      const cached = getCached<BudgetPolicy | null>(key);
      if (cached !== undefined) {
        return cached;
      }
      const value = await underlying.getBudgetPolicy(principalId, scopeKind);
      setCached(key, value);
      return value;
    },

    async getConfigVersion() {
      return underlying.getConfigVersion();
    },

    async bumpConfigVersion() {
      return underlying.bumpConfigVersion();
    },
  };
}
