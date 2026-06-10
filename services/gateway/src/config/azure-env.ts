export interface AzureEnv {
  openAiEndpoint: string;
  openAiKey: string;
  openAiChatApiVersion: string;
  openAiResponsesApiVersion: string;
  foundryEndpoint: string;
  foundryKey: string;
  foundryChatApiVersion: string;
}

export function loadAzureEnv(): AzureEnv {
  return {
    openAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT ?? '',
    openAiKey: process.env.AZURE_OPENAI_KEY ?? '',
    openAiChatApiVersion: process.env.AZURE_OPENAI_CHAT_API_VERSION ?? '2025-01-01-preview',
    openAiResponsesApiVersion: process.env.AZURE_OPENAI_RESPONSES_API_VERSION ?? '2025-04-01-preview',
    foundryEndpoint: process.env.AZURE_AI_FOUNDRY_ENDPOINT ?? '',
    foundryKey: process.env.AZURE_AI_FOUNDRY_KEY ?? process.env.AZURE_OPENAI_KEY ?? '',
    foundryChatApiVersion: process.env.AZURE_FOUNDRY_CHAT_API_VERSION ?? '2024-05-01-preview',
  };
}

export function isAzureConfigured(env: AzureEnv): boolean {
  const openAiReady = Boolean(env.openAiEndpoint && env.openAiKey);
  const foundryReady = Boolean(env.foundryEndpoint && env.foundryKey);
  return openAiReady || foundryReady;
}
