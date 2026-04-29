import { env } from './env';

// Type definitions
export type ModelFamily = 'gpt' | 'claude' | 'kimi' | 'glm' | 'minimax';
export type ProtocolFamily = 'chat-completions' | 'anthropic-messages';
export type AzureAuthType = 'entra-id' | 'api-key';

// Azure auth configuration
export interface AzureAuthConfig {
  type: AzureAuthType;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  apiKey?: string;
  keyHeader?: 'api-key' | 'x-api-key' | 'Authorization';
}

// Deployment configuration
export interface DeploymentConfig {
  name: string;
  modelAlias: string;
  modelFamily: ModelFamily;
  protocolFamily: ProtocolFamily;
  azureModelName: string;
  endpoint: string;
  authConfig: AzureAuthConfig;
  apiVersion: string;
  fallbackDeployment?: string;
  enabled: boolean;
}

// Build auth config for Azure OpenAI (GPT models)
function buildAzureOpenAIAuth(): AzureAuthConfig {
  if (env.AZURE_ENTRA_TENANT_ID && env.AZURE_ENTRA_CLIENT_ID && env.AZURE_ENTRA_CLIENT_SECRET) {
    return {
      type: 'entra-id',
      tenantId: env.AZURE_ENTRA_TENANT_ID,
      clientId: env.AZURE_ENTRA_CLIENT_ID,
      clientSecret: env.AZURE_ENTRA_CLIENT_SECRET,
      scope: 'https://cognitiveservices.azure.com/.default',
    };
  }
  return {
    type: 'api-key',
    apiKey:
      env.AZURE_OPENAI_KEY ||
      (process.env.NODE_ENV === 'test' ? 'test-azure-openai-key' : undefined),
    keyHeader: 'api-key',
  };
}

// Build auth config for Azure AI Foundry
function buildFoundryAuth(): AzureAuthConfig {
  if (env.AZURE_ENTRA_TENANT_ID && env.AZURE_ENTRA_CLIENT_ID && env.AZURE_ENTRA_CLIENT_SECRET) {
    return {
      type: 'entra-id',
      tenantId: env.AZURE_ENTRA_TENANT_ID,
      clientId: env.AZURE_ENTRA_CLIENT_ID,
      clientSecret: env.AZURE_ENTRA_CLIENT_SECRET,
      scope: 'https://ai.azure.com/.default',
    };
  }
  return {
    type: 'api-key',
    apiKey:
      env.AZURE_AI_FOUNDRY_KEY ||
      (process.env.NODE_ENV === 'test' ? 'test-foundry-key' : undefined),
    keyHeader: 'x-api-key',
  };
}

// All 8 model deployments
const DEPLOYMENTS: DeploymentConfig[] = [
  // GPT models via Azure OpenAI
  {
    name: 'gpt-5.4-global',
    modelAlias: 'gpt-5.4',
    modelFamily: 'gpt',
    protocolFamily: 'chat-completions',
    azureModelName: 'gpt-5.4',
    endpoint: env.AZURE_OPENAI_ENDPOINT || 'https://example.openai.azure.com',
    authConfig: buildAzureOpenAIAuth(),
    apiVersion: '2024-06-01',
    fallbackDeployment: 'gpt-5.3-codex',
    enabled: true,
  },
  {
    name: 'gpt-5.3-codex',
    modelAlias: 'gpt-5.3-codex',
    modelFamily: 'gpt',
    protocolFamily: 'chat-completions',
    azureModelName: 'gpt-5.3-codex',
    endpoint: env.AZURE_OPENAI_ENDPOINT || 'https://example.openai.azure.com',
    authConfig: buildAzureOpenAIAuth(),
    apiVersion: '2024-06-01',
    enabled: true,
  },
  // Claude models via Azure AI Foundry (Anthropic Messages API)
  {
    name: 'claude-opus-4-6',
    modelAlias: 'claude-opus-4-6',
    modelFamily: 'claude',
    protocolFamily: 'anthropic-messages',
    azureModelName: 'claude-opus-4-6',
    endpoint: env.AZURE_AI_FOUNDRY_ENDPOINT || 'https://example.ai.azure.com',
    authConfig: buildFoundryAuth(),
    apiVersion: '2023-06-01',
    fallbackDeployment: 'claude-sonnet-4-6',
    enabled: true,
  },
  {
    name: 'claude-sonnet-4-6',
    modelAlias: 'claude-sonnet-4-6',
    modelFamily: 'claude',
    protocolFamily: 'anthropic-messages',
    azureModelName: 'claude-sonnet-4-6',
    endpoint: env.AZURE_AI_FOUNDRY_ENDPOINT || 'https://example.ai.azure.com',
    authConfig: buildFoundryAuth(),
    apiVersion: '2023-06-01',
    fallbackDeployment: 'claude-haiku-4-5',
    enabled: true,
  },
  {
    name: 'claude-haiku-4-5',
    modelAlias: 'claude-haiku-4-5',
    modelFamily: 'claude',
    protocolFamily: 'anthropic-messages',
    azureModelName: 'claude-haiku-4-5',
    endpoint: env.AZURE_AI_FOUNDRY_ENDPOINT || 'https://example.ai.azure.com',
    authConfig: buildFoundryAuth(),
    apiVersion: '2023-06-01',
    enabled: true,
  },
  // Third-party models via Azure AI Foundry (OpenAI-compatible)
  {
    name: 'kimi-k2.5',
    modelAlias: 'kimi-k2.5',
    modelFamily: 'kimi',
    protocolFamily: 'chat-completions',
    azureModelName: 'FW-Kimi-K2.5',
    endpoint: env.AZURE_AI_FOUNDRY_ENDPOINT || 'https://example.ai.azure.com',
    authConfig: buildFoundryAuth(),
    apiVersion: '2024-06-01',
    enabled: true,
  },
  {
    name: 'glm-5',
    modelAlias: 'glm-5',
    modelFamily: 'glm',
    protocolFamily: 'chat-completions',
    azureModelName: 'FW-GLM-5',
    endpoint: env.AZURE_AI_FOUNDRY_ENDPOINT || 'https://example.ai.azure.com',
    authConfig: buildFoundryAuth(),
    apiVersion: '2024-06-01',
    enabled: true,
  },
  {
    name: 'minimax-m2.5',
    modelAlias: 'minimax-m2.5',
    modelFamily: 'minimax',
    protocolFamily: 'chat-completions',
    azureModelName: 'FW-MiniMax-M2.5',
    endpoint: env.AZURE_AI_FOUNDRY_ENDPOINT || 'https://example.ai.azure.com',
    authConfig: buildFoundryAuth(),
    apiVersion: '2024-06-01',
    enabled: true,
  },
];

// Lookup maps for fast access
const DEPLOYMENT_BY_ALIAS = new Map<string, DeploymentConfig>();
const DEPLOYMENTS_BY_FAMILY = new Map<ModelFamily, DeploymentConfig[]>();

// Initialize lookup maps
for (const deployment of DEPLOYMENTS) {
  DEPLOYMENT_BY_ALIAS.set(deployment.modelAlias.toLowerCase(), deployment);

  const familyDeployments = DEPLOYMENTS_BY_FAMILY.get(deployment.modelFamily) || [];
  familyDeployments.push(deployment);
  DEPLOYMENTS_BY_FAMILY.set(deployment.modelFamily, familyDeployments);
}

/**
 * Get deployment configuration by model alias (case-insensitive)
 */
export function getDeploymentByAlias(alias: string): DeploymentConfig | undefined {
  return DEPLOYMENT_BY_ALIAS.get(alias.toLowerCase());
}

/**
 * Get model family for a given alias
 */
export function getModelFamily(alias: string): ModelFamily | undefined {
  const deployment = getDeploymentByAlias(alias);
  return deployment?.modelFamily;
}

/**
 * Get protocol family for a given alias
 */
export function getProtocolFamily(alias: string): ProtocolFamily | undefined {
  const deployment = getDeploymentByAlias(alias);
  return deployment?.protocolFamily;
}

/**
 * Get all deployments for a given model family
 */
export function getDeploymentsByFamily(family: ModelFamily): DeploymentConfig[] {
  return DEPLOYMENTS_BY_FAMILY.get(family) || [];
}

/**
 * Get all enabled deployments
 */
export function getAllDeployments(): DeploymentConfig[] {
  return DEPLOYMENTS.filter((d) => d.enabled);
}

/**
 * Resolve fallback chain for a deployment (same protocol family only)
 */
export function getFallbackChain(deployment: DeploymentConfig): DeploymentConfig[] {
  const chain: DeploymentConfig[] = [];
  let current: DeploymentConfig | undefined = deployment;

  while (current?.fallbackDeployment) {
    const fallback = DEPLOYMENTS.find((d) => d.name === current!.fallbackDeployment);
    if (fallback?.enabled && fallback.protocolFamily === current.protocolFamily) {
      chain.push(fallback);
      current = fallback;
    } else {
      break;
    }
  }

  return chain;
}

/**
 * Get all known model aliases
 */
export function getAllModelAliases(): string[] {
  return Array.from(DEPLOYMENT_BY_ALIAS.keys());
}

// Export deployments array for external use
export { DEPLOYMENTS };
