import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '@shared/contracts/tenant';
import { buildAzureAuthHeaders, buildAzureUpstreamUrl } from './azure';

const env = {
  openAiEndpoint: 'https://my-ms-aif.cognitiveservices.azure.com',
  openAiKey: 'key-openai',
  openAiChatApiVersion: '2025-01-01-preview',
  openAiResponsesApiVersion: '2025-04-01-preview',
  foundryEndpoint: 'https://my-ms-aif.services.ai.azure.com',
  foundryKey: 'key-foundry',
  foundryChatApiVersion: '2024-05-01-preview',
};

describe('azure provider routing', () => {
  it('builds chat completions URL for azure-openai', () => {
    const model: ModelConfig = {
      alias: 'gpt-4.1',
      provider: 'azure-openai',
      family: 'openai-chat',
      upstreamApi: 'chat-completions',
      deploymentName: 'gpt-4.1',
      enabled: true,
      priceInPerMillion: '1',
      priceOutPerMillion: '1',
    };
    expect(buildAzureUpstreamUrl(model, env)).toBe(
      'https://my-ms-aif.cognitiveservices.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=2025-01-01-preview',
    );
    expect(buildAzureAuthHeaders(model, env)).toEqual({ 'api-key': 'key-openai' });
  });

  it('builds responses URL for codex models', () => {
    const model: ModelConfig = {
      alias: 'gpt-5.1-codex-mini',
      provider: 'azure-openai',
      family: 'openai-responses',
      upstreamApi: 'responses',
      deploymentName: 'gpt-5.1-codex-mini',
      enabled: true,
      priceInPerMillion: '1',
      priceOutPerMillion: '1',
    };
    expect(buildAzureUpstreamUrl(model, env)).toBe(
      'https://my-ms-aif.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview',
    );
  });

  it('builds foundry models chat URL', () => {
    const model: ModelConfig = {
      alias: 'Kimi-K2.5',
      provider: 'azure-foundry',
      family: 'openai-chat',
      upstreamApi: 'chat-completions',
      deploymentName: 'Kimi-K2.5',
      enabled: true,
      priceInPerMillion: '1',
      priceOutPerMillion: '1',
    };
    expect(buildAzureUpstreamUrl(model, env)).toBe(
      'https://my-ms-aif.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview',
    );
    expect(buildAzureAuthHeaders(model, env)).toEqual({ 'api-key': 'key-foundry' });
  });
});
