# cURL smoke tests — LLM Gateway & Azure providers

Reproducible commands for **my-ms-aif** models. Default prompt: `Reply with exactly: OK` (expect assistant content `OK`).

## Prerequisites

```bash
# From repo root
make up

# Load Azure endpoints + keys (never commit this file)
set -a
source deploy/compose/.env
set +a

export EDGE="${EDGE:-http://localhost:8080}"
export DEV_IDP="${DEV_IDP:-http://localhost:4000}"
export SMOKE_INPUT="${SMOKE_INPUT:-Reply with exactly: OK}"
```

## Mint dev token

Principal `seed-sp-appid` can call all five models.

```bash
export TOKEN="$(
  curl -sf -X POST "$DEV_IDP/token" \
    -H 'content-type: application/json' \
    -d '{
      "audience": "api://ai-gateway-edge",
      "claims": {
        "appid": "seed-sp-appid",
        "idtyp": "app",
        "roles": "proj1"
      }
    }' | jq -r .access_token
)"

echo "TOKEN length: ${#TOKEN}"
```

## Health checks

```bash
curl -sf "$EDGE/health" | jq .
curl -sf "$EDGE/ready" | jq .
curl -sf http://localhost:4100/health | jq .
```

---

## Through LLM Gateway (edge → gateway → Azure)

All requests use `POST /v1/chat/completions` unless noted. Responses-only models are bridged automatically.

### gpt-4.1 — azure-openai (chat-completions)

```bash
curl -sS -X POST "$EDGE/v1/chat/completions" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{
    \"model\": \"gpt-4.1\",
    \"messages\": [{\"role\": \"user\", \"content\": \"$SMOKE_INPUT\"}],
    \"stream\": false
  }" | jq '{status: "ok", content: .choices[0].message.content, model: .model, id: .id}'
```

### gpt-5-mini — azure-openai (responses via chat bridge)

```bash
curl -sS -X POST "$EDGE/v1/chat/completions" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{
    \"model\": \"gpt-5-mini\",
    \"messages\": [{\"role\": \"user\", \"content\": \"$SMOKE_INPUT\"}],
    \"stream\": false
  }" | jq '{status: "ok", content: .choices[0].message.content, model: .model, id: .id}'
```

### gpt-5.1-codex-mini — azure-openai (responses via chat bridge)

```bash
curl -sS -X POST "$EDGE/v1/chat/completions" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{
    \"model\": \"gpt-5.1-codex-mini\",
    \"messages\": [{\"role\": \"user\", \"content\": \"$SMOKE_INPUT\"}],
    \"stream\": false
  }" | jq '{status: "ok", content: .choices[0].message.content, model: .model, id: .id}'
```

### DeepSeek-V4-Flash — azure-foundry (chat-completions)

```bash
curl -sS -X POST "$EDGE/v1/chat/completions" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{
    \"model\": \"DeepSeek-V4-Flash\",
    \"messages\": [{\"role\": \"user\", \"content\": \"$SMOKE_INPUT\"}],
    \"stream\": false
  }" | jq '{status: "ok", content: .choices[0].message.content, model: .model, id: .id}'
```

### Kimi-K2.5 — azure-foundry (chat-completions)

```bash
curl -sS -X POST "$EDGE/v1/chat/completions" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{
    \"model\": \"Kimi-K2.5\",
    \"messages\": [{\"role\": \"user\", \"content\": \"$SMOKE_INPUT\"}],
    \"stream\": false
  }" | jq '{status: "ok", content: .choices[0].message.content, model: .model, id: .id}'
```

### Native Responses route — gpt-5-mini

```bash
curl -sS -X POST "$EDGE/v1/responses" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{
    \"model\": \"gpt-5-mini\",
    \"input\": \"$SMOKE_INPUT\",
    \"stream\": false
  }" | jq '{id: .id, model: .model, output: .output}'
```

### Negative — unknown model (expect HTTP 403)

```bash
curl -sS -w "\nHTTP %{http_code}\n" -X POST "$EDGE/v1/chat/completions" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "model": "unknown-model",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

---

## Direct to Azure providers (bypass gateway)

Requires `AZURE_OPENAI_*` and `AZURE_AI_FOUNDRY_*` from `deploy/compose/.env`.

### gpt-4.1 — Azure OpenAI chat completions

```bash
curl -sS -X POST \
  "${AZURE_OPENAI_ENDPOINT%/}/openai/deployments/gpt-4.1/chat/completions?api-version=${AZURE_OPENAI_CHAT_API_VERSION}" \
  -H "api-key: $AZURE_OPENAI_KEY" \
  -H 'content-type: application/json' \
  -d "{
    \"messages\": [{\"role\": \"user\", \"content\": \"$SMOKE_INPUT\"}],
    \"stream\": false
  }" | jq '{content: .choices[0].message.content, model: .model, id: .id}'
```

### gpt-5-mini — Azure OpenAI Responses API

```bash
curl -sS -X POST \
  "${AZURE_OPENAI_ENDPOINT%/}/openai/responses?api-version=${AZURE_OPENAI_RESPONSES_API_VERSION}" \
  -H "api-key: $AZURE_OPENAI_KEY" \
  -H 'content-type: application/json' \
  -d "{
    \"model\": \"gpt-5-mini\",
    \"input\": \"$SMOKE_INPUT\",
    \"stream\": false
  }" | jq '{id: .id, model: .model, output: .output}'
```

### gpt-5.1-codex-mini — Azure OpenAI Responses API

```bash
curl -sS -X POST \
  "${AZURE_OPENAI_ENDPOINT%/}/openai/responses?api-version=${AZURE_OPENAI_RESPONSES_API_VERSION}" \
  -H "api-key: $AZURE_OPENAI_KEY" \
  -H 'content-type: application/json' \
  -d "{
    \"model\": \"gpt-5.1-codex-mini\",
    \"input\": \"$SMOKE_INPUT\",
    \"stream\": false
  }" | jq '{id: .id, model: .model, output: .output}'
```

### DeepSeek-V4-Flash — Azure AI Foundry chat completions

```bash
curl -sS -X POST \
  "${AZURE_AI_FOUNDRY_ENDPOINT%/}/models/chat/completions?api-version=${AZURE_FOUNDRY_CHAT_API_VERSION}" \
  -H "api-key: ${AZURE_AI_FOUNDRY_KEY:-$AZURE_OPENAI_KEY}" \
  -H 'content-type: application/json' \
  -d "{
    \"model\": \"DeepSeek-V4-Flash\",
    \"messages\": [{\"role\": \"user\", \"content\": \"$SMOKE_INPUT\"}],
    \"stream\": false
  }" | jq '{content: .choices[0].message.content, model: .model, id: .id}'
```

### Kimi-K2.5 — Azure AI Foundry chat completions

```bash
curl -sS -X POST \
  "${AZURE_AI_FOUNDRY_ENDPOINT%/}/models/chat/completions?api-version=${AZURE_FOUNDRY_CHAT_API_VERSION}" \
  -H "api-key: ${AZURE_AI_FOUNDRY_KEY:-$AZURE_OPENAI_KEY}" \
  -H 'content-type: application/json' \
  -d "{
    \"model\": \"Kimi-K2.5\",
    \"messages\": [{\"role\": \"user\", \"content\": \"$SMOKE_INPUT\"}],
    \"stream\": false
  }" | jq '{content: .choices[0].message.content, model: .model, id: .id}'
```

---

## Run all gateway tests (one-liner loop)

```bash
for MODEL in gpt-4.1 gpt-5-mini gpt-5.1-codex-mini DeepSeek-V4-Flash Kimi-K2.5; do
  echo "==> $MODEL"
  curl -sS -X POST "$EDGE/v1/chat/completions" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$SMOKE_INPUT\"}],\"stream\":false}" \
    | jq -r --arg m "$MODEL" '[ $m, (.choices[0].message.content // .error.message // "FAIL") ] | @tsv"'
done
```

## Automated JSON evidence

```bash
./http/run-smoke-evidence.sh
# or
make smoke-evidence
```

Writes full response bodies to `http/evidence/latest-gateway-smoke.json` and `http/evidence/latest-direct-smoke.json`.

## Related files

- [`smoke-gateway.http`](smoke-gateway.http) — REST Client version (gateway)
- [`smoke-providers-direct.http`](smoke-providers-direct.http) — REST Client version (direct)
- [`MODELS.my-ms-aif.md`](../deploy/compose/MODELS.my-ms-aif.md) — endpoint map
