# HTTP smoke tests — reproducible evidence

REST Client / HTTP Client files to reproduce model smoke tests against **my-ms-aif**.

## Files

| File | Purpose |
|------|---------|
| [`mint-token.http`](mint-token.http) | Mint dev JWT from compose dev-idp |
| [`smoke-gateway.http`](smoke-gateway.http) | All 5 models via **edge → gateway → Azure** |
| [`smoke-providers-direct.http`](smoke-providers-direct.http) | Same models **direct to Azure** (native APIs) |
| [`http-client.env.json`](http-client.env.json) | Shared variables (`local`, `azure-direct`) |
| [`run-smoke-evidence.sh`](run-smoke-evidence.sh) | CLI runner → JSON evidence in `evidence/` |
| [`curl-smoke-tests.md`](curl-smoke-tests.md) | Copy-paste **curl** commands (gateway + direct) |

## IDE (VS Code / Cursor REST Client)

1. Start stack: `make up`
2. Open [`smoke-gateway.http`](smoke-gateway.http)
3. Select environment **`local`** (bottom-right in REST Client)
4. Run **Mint token**, then each model request
5. Expect HTTP **200** and `choices[0].message.content` = `"OK"`

For direct Azure tests:

1. Copy `http-client.private.env.json.example` → `http-client.private.env.json`
2. Paste keys from `deploy/compose/.env` (never commit private file)
3. Open [`smoke-providers-direct.http`](smoke-providers-direct.http)
4. Select environment **`azure-direct`**

## CLI evidence (JSON artifacts)

```bash
chmod +x http/run-smoke-evidence.sh
./http/run-smoke-evidence.sh
```

Writes timestamped files plus:

- `http/evidence/latest-gateway-smoke.json`
- `http/evidence/latest-direct-smoke.json`

Each result row includes full upstream `response` body for audit.

## Models covered

| Model | Provider | Gateway route | Direct upstream |
|-------|----------|---------------|-----------------|
| gpt-4.1 | azure-openai | `/v1/chat/completions` | chat/completions deployment |
| gpt-5-mini | azure-openai | `/v1/chat/completions` (bridge) | `/openai/responses` |
| gpt-5.1-codex-mini | azure-openai | `/v1/chat/completions` (bridge) | `/openai/responses` |
| DeepSeek-V4-Flash | azure-foundry | `/v1/chat/completions` | Foundry models chat |
| Kimi-K2.5 | azure-foundry | `/v1/chat/completions` | Foundry models chat |

Default prompt: `Reply with exactly: OK`
