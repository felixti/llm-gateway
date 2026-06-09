import type { BudgetPolicy, ModelConfig, PrincipalRecord } from '@shared/contracts/tenant';

export interface ConfigStore {
  getModel(alias: string): Promise<ModelConfig | null>;
  listModels(): Promise<ModelConfig[]>;
  getPrincipal(principalId: string): Promise<PrincipalRecord | null>;
  getBudgetPolicy(principalId: string, scopeKind: 'user' | 'project'): Promise<BudgetPolicy | null>;
  getConfigVersion(): Promise<number>;
  bumpConfigVersion(): Promise<number>;
}
