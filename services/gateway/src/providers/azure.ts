import type { AzureEnv } from '../config/azure-env';
import type { ModelConfig } from '@shared/contracts/tenant';
import type { UpstreamApiKind } from '../protocol/responses-chat-bridge';

export function buildAzureUpstreamUrl(
  model: ModelConfig,
  env: AzureEnv,
): string {
  if (model.provider === 'azure-foundry') {
    const base = env.foundryEndpoint.replace(/\/$/, '');
    return `${base}/models/chat/completions?api-version=${env.foundryChatApiVersion}`;
  }

  const base = env.openAiEndpoint.replace(/\/$/, '');
  if (model.upstreamApi === 'responses') {
    return `${base}/openai/responses?api-version=${env.openAiResponsesApiVersion}`;
  }
  return `${base}/openai/deployments/${model.deploymentName}/chat/completions?api-version=${env.openAiChatApiVersion}`;
}

export function buildAzureAuthHeaders(model: ModelConfig, env: AzureEnv): Record<string, string> {
  if (model.provider === 'azure-foundry') {
    return { 'api-key': env.foundryKey };
  }
  return { 'api-key': env.openAiKey };
}

export function prepareUpstreamBody(
  model: ModelConfig,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const upstream: Record<string, unknown> = { ...body };

  if (model.provider === 'azure-foundry') {
    upstream.model = model.deploymentName;
  }

  if (model.upstreamApi === 'responses' && typeof upstream.model === 'string') {
    upstream.model = model.deploymentName;
  }

  if (upstream.max_tokens && !upstream.max_completion_tokens && !upstream.max_output_tokens) {
    upstream.max_completion_tokens = upstream.max_tokens;
    delete upstream.max_tokens;
  }

  return upstream;
}

export function upstreamApiForModel(model: ModelConfig): UpstreamApiKind {
  return model.upstreamApi;
}
