import type { BudgetPolicy, ModelConfig, PrincipalRecord } from '@shared/contracts/tenant';
import type { ConfigStore } from './types';
import { createSeedData } from './seed';

type SeedData = {
  models: ModelConfig[];
  principals: PrincipalRecord[];
  budgets: BudgetPolicy[];
};

function indexModels(models: ModelConfig[]): Map<string, ModelConfig> {
  return new Map(models.map((m) => [m.alias, m]));
}

function indexPrincipals(principals: PrincipalRecord[]): Map<string, PrincipalRecord> {
  return new Map(principals.map((p) => [p.principalId, p]));
}

function indexBudgets(budgets: BudgetPolicy[]): Map<string, BudgetPolicy> {
  return new Map(budgets.map((b) => [`${b.scopeKind}:${b.principalId}`, b]));
}

export function createMemoryConfigStore(seed: SeedData = createSeedData()): ConfigStore {
  const models = indexModels(seed.models);
  const principals = indexPrincipals(seed.principals);
  const budgets = indexBudgets(seed.budgets);
  let configVersion = 1;

  return {
    async getModel(alias) {
      return models.get(alias) ?? null;
    },
    async listModels() {
      return [...models.values()];
    },
    async getPrincipal(principalId) {
      return principals.get(principalId) ?? null;
    },
    async getBudgetPolicy(principalId, scopeKind) {
      return budgets.get(`${scopeKind}:${principalId}`) ?? null;
    },
    async getConfigVersion() {
      return configVersion;
    },
    async bumpConfigVersion() {
      configVersion += 1;
      return configVersion;
    },
  };
}
