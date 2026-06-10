# Azure model map — my-ms-aif (reference only, no secrets)
#
# Providers:
#   azure-openai  → https://my-ms-aif.cognitiveservices.azure.com
#   azure-foundry → https://my-ms-aif.services.ai.azure.com
#
# | Alias (client `model`) | Provider      | Upstream API    | Client routes |
# |------------------------|---------------|-----------------|---------------|
# | gpt-4.1                | azure-openai  | chat-completions| /v1/chat/completions, /v1/responses* |
# | gpt-5-mini             | azure-openai  | responses       | /v1/responses, /v1/chat/completions* |
# | gpt-5.1-codex-mini     | azure-openai  | responses       | /v1/responses, /v1/chat/completions* |
# | DeepSeek-V4-Flash      | azure-foundry | chat-completions| /v1/chat/completions, /v1/responses* |
# | Kimi-K2.5              | azure-foundry | chat-completions| /v1/chat/completions, /v1/responses* |
#
# * Gateway adapts between Chat Completions and Responses API when the client route
#   does not match the model's native upstream API (non-streaming).
#
# Azure paths:
#   Chat:      .../openai/deployments/{deployment}/chat/completions?api-version=2025-01-01-preview
#   Responses: .../openai/responses?api-version=2025-04-01-preview
#   Foundry:   .../models/chat/completions?api-version=2024-05-01-preview
#
# Env (see deploy/compose/.env):
#   AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY
#   AZURE_AI_FOUNDRY_ENDPOINT, AZURE_AI_FOUNDRY_KEY
#   UPSTREAM_MODE=azure   # use stub when unset and no endpoints configured
