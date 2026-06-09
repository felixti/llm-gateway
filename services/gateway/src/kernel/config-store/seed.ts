import type { BudgetPolicy, ModelConfig, PrincipalRecord } from '@shared/contracts/tenant';

const MODELS: ModelConfig[] = [
  {
    alias: 'gpt-5.4',
    provider: 'azure-openai',
    family: 'openai-chat',
    deploymentName: 'gpt-5.4-global',
    enabled: true,
    priceInPerMillion: '5.000000',
    priceOutPerMillion: '15.000000',
    fallbackAlias: 'gpt-5.3-codex',
  },
  {
    alias: 'gpt-5-mini',
    provider: 'azure-openai',
    family: 'openai-chat',
    deploymentName: 'gpt-5-mini',
    enabled: true,
    priceInPerMillion: '0.250000',
    priceOutPerMillion: '2.000000',
    fallbackAlias: 'gpt-5.3-codex',
  },
  {
    alias: 'claude-opus-4-6',
    provider: 'azure-foundry',
    family: 'anthropic-messages',
    deploymentName: 'claude-opus-4-6',
    enabled: true,
    priceInPerMillion: '15.000000',
    priceOutPerMillion: '75.000000',
    fallbackAlias: 'claude-sonnet-4-6',
  },
  {
    alias: 'claude-haiku-4-5',
    provider: 'azure-foundry',
    family: 'anthropic-messages',
    deploymentName: 'claude-haiku-4-5',
    enabled: true,
    priceInPerMillion: '0.250000',
    priceOutPerMillion: '1.250000',
  },
];

const PRINCIPALS: PrincipalRecord[] = [
  {
    principalId: 'seed-sp-appid',
    kind: 'sp',
    projectId: 'seed-project',
    orgId: 'internal',
    modelAllowlist: ['gpt-5.4', 'claude-opus-4-6'],
  },
  {
    principalId: 'seed-user-oid',
    kind: 'user',
    projectId: null,
    orgId: 'internal',
    modelAllowlist: ['gpt-5-mini', 'claude-haiku-4-5'],
  },
  {
    principalId: 'app1',
    kind: 'sp',
    projectId: 'proj1',
    orgId: 'internal',
    modelAllowlist: ['gpt-5.4', 'claude-opus-4-6'],
  },
];

const BUDGETS: BudgetPolicy[] = [
  {
    principalId: 'seed-user-oid',
    scopeKind: 'user',
    capUsd: '50.000000',
    period: 'monthly',
    hard: true,
  },
  {
    principalId: 'seed-project',
    scopeKind: 'project',
    capUsd: '100.000000',
    period: 'monthly',
    hard: true,
  },
  {
    principalId: 'proj1',
    scopeKind: 'project',
    capUsd: '100.000000',
    period: 'monthly',
    hard: true,
  },
];

export function createSeedData(): {
  models: ModelConfig[];
  principals: PrincipalRecord[];
  budgets: BudgetPolicy[];
} {
  return { models: MODELS, principals: PRINCIPALS, budgets: BUDGETS };
}
