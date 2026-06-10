import type { PrincipalKind } from './claims';

export type ProtocolFamily = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
export type ModelProvider = 'azure-openai' | 'azure-foundry';
/** Native Azure upstream surface for this deployment. */
export type UpstreamApi = 'chat-completions' | 'responses';

export interface ModelConfig {
  alias: string;
  provider: ModelProvider;
  /** Client-native protocol; cross-protocol adapters bridge at the gateway. */
  family: ProtocolFamily;
  upstreamApi: UpstreamApi;
  deploymentName: string;
  enabled: boolean;
  priceInPerMillion: string;   // USD decimal string, 6dp
  priceOutPerMillion: string;
  fallbackAlias?: string;
}

export interface BudgetPolicy {
  principalId: string;
  scopeKind: 'user' | 'project';
  capUsd: string;              // USD decimal string
  period: 'monthly' | 'daily';
  hard: boolean;
}

export interface PrincipalRecord {
  principalId: string;
  kind: PrincipalKind;
  projectId: string | null;
  orgId: string;
  modelAllowlist: string[];
}

/** Resolved per-request tenancy + policy (M1). Budget enforcement is M2. */
export interface TenantContext {
  principalId: string;
  principalKind: PrincipalKind;
  projectId: string | null;
  orgId: string;
  modelAllowlist: string[];
  budgetPolicy: BudgetPolicy | null;
}
