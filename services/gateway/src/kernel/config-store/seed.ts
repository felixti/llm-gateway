import type { BudgetPolicy, ModelConfig, PrincipalRecord } from '@shared/contracts/tenant';

/**
 * Local / compose code seed — deployment names match Azure resource `my-ms-aif`.
 */
const MODELS: ModelConfig[] = [
  {
    alias: 'gpt-4.1',
    provider: 'azure-openai',
    family: 'openai-chat',
    upstreamApi: 'chat-completions',
    deploymentName: 'gpt-4.1',
    enabled: true,
    priceInPerMillion: '2.000000',
    priceOutPerMillion: '8.000000',
  },
  {
    alias: 'gpt-5-mini',
    provider: 'azure-openai',
    family: 'openai-responses',
    upstreamApi: 'responses',
    deploymentName: 'gpt-5-mini',
    enabled: true,
    priceInPerMillion: '0.250000',
    priceOutPerMillion: '2.000000',
  },
  {
    alias: 'gpt-5.1-codex-mini',
    provider: 'azure-openai',
    family: 'openai-responses',
    upstreamApi: 'responses',
    deploymentName: 'gpt-5.1-codex-mini',
    enabled: true,
    priceInPerMillion: '0.500000',
    priceOutPerMillion: '2.000000',
  },
  {
    alias: 'DeepSeek-V4-Flash',
    provider: 'azure-foundry',
    family: 'openai-chat',
    upstreamApi: 'chat-completions',
    deploymentName: 'DeepSeek-V4-Flash',
    enabled: true,
    priceInPerMillion: '0.140000',
    priceOutPerMillion: '0.280000',
  },
  {
    alias: 'Kimi-K2.5',
    provider: 'azure-foundry',
    family: 'openai-chat',
    upstreamApi: 'chat-completions',
    deploymentName: 'Kimi-K2.5',
    enabled: true,
    priceInPerMillion: '0.500000',
    priceOutPerMillion: '2.000000',
  },
];

const ALL_ALIASES = MODELS.filter((m) => m.enabled).map((m) => m.alias);

const PRINCIPALS: PrincipalRecord[] = [
  {
    principalId: 'seed-sp-appid',
    kind: 'sp',
    projectId: 'seed-project',
    orgId: 'internal',
    modelAllowlist: ALL_ALIASES,
  },
  {
    principalId: 'seed-user-oid',
    kind: 'user',
    projectId: null,
    orgId: 'internal',
    modelAllowlist: ['gpt-4.1', 'gpt-5-mini', 'Kimi-K2.5'],
  },
  {
    principalId: 'app1',
    kind: 'sp',
    projectId: 'proj1',
    orgId: 'internal',
    modelAllowlist: ['gpt-4.1', 'DeepSeek-V4-Flash', 'Kimi-K2.5', 'gpt-5.1-codex-mini'],
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
  return {
    models: MODELS.map((m) => ({ ...m })),
    principals: PRINCIPALS.map((p) => ({ ...p, modelAllowlist: [...p.modelAllowlist] })),
    budgets: BUDGETS.map((b) => ({ ...b })),
  };
}
