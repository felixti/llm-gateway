# Local development — AI Gateway MVP

Two ways to run locally **without Azure Entra or production storage**:

| Mode | Best for | Command |
|------|----------|---------|
| **Docker Compose (recommended)** | Full stack, E2E, collector pipeline | `./deploy/compose/local-up.sh` |
| **Host-native** | Debugging a single service in your IDE | Infra in Docker + `yarn`/`dotnet run` |

Environment templates:

- **Compose (all-in-docker):** [`deploy/compose/.env.example`](../compose/.env.example)
- **Host-native:** [`deploy/local/.env.example`](.env.example)

---

## Prerequisites

| Tool | Version | Used by |
|------|---------|---------|
| Docker + Compose | v2+ | Compose stack, Azurite, Redis |
| Node.js | 24+ | Gateway, collector (host mode) |
| .NET SDK | 9+ | Edge (host mode) |
| yarn | 1.x | Node services |

---

## Option A — Full stack in Docker (recommended)

### 1. Create env file

```bash
cp deploy/compose/.env.example deploy/compose/.env
```

The defaults in `.env.example` are **pre-filled for fully local** operation. You do **not** need an Azure subscription to start.

### 2. Start everything

```bash
chmod +x deploy/compose/local-up.sh deploy/compose/local-e2e.sh
./deploy/compose/local-up.sh
```

This starts:

| Service | Host port | Role |
|---------|-----------|------|
| **edge** | `8080` | YARP — API entrypoint |
| **dev-idp** | `4000` | Local JWT issuer (replaces Entra) |
| **collector** | `4100` | Drains usage queue → batch files |
| **Azurite** | `10000–10002` | Queue + Table emulator |
| Redis, gateway | internal | Budget/rate-limit + LLM plane |

### 3. Smoke test

```bash
./deploy/compose/local-e2e.sh
# or: docker compose -f deploy/compose/docker-compose.yml --profile e2e run --rm e2e
```

### 4. Manual request

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/token \
  -H 'content-type: application/json' \
  -d '{"audience":"api://ai-gateway-edge","claims":{"appid":"seed-sp-appid","idtyp":"app","roles":"proj1"}}' \
  | jq -r .access_token)

curl -s -X POST http://localhost:8080/v1/chat/completions \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4","messages":[]}' | jq
```

Check usage pipeline:

```bash
curl -s http://localhost:4100/health | jq   # collector batches_written
docker compose -f deploy/compose/docker-compose.yml exec collector ls /data/out
```

---

## Option B — Host-native (IDE debugging)

Run **infra only** in Docker, services on your machine.

### 1. Start infra

```bash
cp deploy/compose/.env.example deploy/compose/.env
docker compose -f deploy/compose/docker-compose.yml up -d redis azurite dev-idp
```

### 2. Load host env

```bash
cp deploy/local/.env.example deploy/local/.env
set -a && source deploy/local/.env && set +a
```

### 3. Run services (three terminals)

```bash
# Terminal 1 — gateway
cd services/gateway && yarn install && yarn build && node dist/server.js

# Terminal 2 — collector
cd services/collector && yarn install && yarn build && node dist/server.js

# Terminal 3 — edge (gateway must be on :3000; see note below)
cd services/edge && ASPNETCORE_ENVIRONMENT=Compose dotnet run
```

**Edge → gateway address:** `appsettings.Compose.json` points at `http://gateway:3000` (Docker DNS). For host-native edge, override the YARP cluster destination to `http://127.0.0.1:3000` via `appsettings.Development.json` or environment — or use Option A for edge in Docker and only debug gateway/collector on the host.

---

## Environment variable reference

### Always set for local (pre-filled in `.env.example`)

| Variable | Default (compose) | Purpose |
|----------|-------------------|---------|
| `EDGE_PORT` | `8080` | Public API port |
| `DEV_IDP_PORT` | `4000` | Token minting for manual tests |
| `AZURE_STORAGE_CONNECTION_STRING` | Azurite | Shared queue (gateway + collector) |
| `USAGE_QUEUE` | `azure` | `azure` = Storage Queue; `memory` = in-process only |
| `USAGE_QUEUE_NAME` | `usage-events` | Queue name |
| `REDIS_URL` | `redis://redis:6379` | Budget + rate-limit |
| `M2M_JWKS_URL` | `http://dev-idp:4000/keys` | Gateway validates YARP M2M token |
| `M2M_EXPECTED_ISSUER` | `http://dev-idp:4000` | Must match token `iss` |
| `M2M_EXPECTED_AUDIENCE` | `api://llm-gateway-internal` | Must match token `aud` |
| `M2M_EXPECTED_APPID` | `yarp-compose-dev` | Must match YARP app id claim |
| `TENANCY_DEFAULT_ORG` | `internal` | Org id in tenant context |
| `CONFIG_STORE` | `memory` | `memory` = code seed; `table` = Azurite/Azure Table |
| `WAL_DIR` | `/tmp/wal` | Usage event WAL when queue enqueue fails |
| `COLLECTOR_OUT_DIR` | `/data/out` | Stub ADX batch output (compose volume) |

### Tuning (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `RATE_LIMIT_RPM` | `1000` | Requests/minute per principal (local: generous) |
| `RATE_LIMIT_TPM` | `1000000` | Tokens/minute per principal |
| `BUDGET_RESERVE_MULTIPLIER` | `1.2` | Reserve headroom (ADR-0013) |
| `BUDGET_RESERVATION_TTL_SEC` | `300` | Orphan reservation TTL |
| `WAL_REPLAY_INTERVAL_MS` | `60000` | WAL → queue replay interval |
| `COLLECTOR_POLL_INTERVAL_MS` | `5000` | Collector poll interval |

### Fill when connecting to real Azure (not needed for local stubs)

| Variable | When required |
|----------|---------------|
| `AZURE_ENTRA_TENANT_ID` | Production Entra instead of dev-idp |
| `AZURE_ENTRA_CLIENT_ID` / `AZURE_ENTRA_CLIENT_SECRET` | Gateway → Azure OpenAI/Foundry auth |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_KEY` | Real GPT proxy (future M-Proxy) |
| `AZURE_AI_FOUNDRY_ENDPOINT` / `AZURE_AI_FOUNDRY_KEY` | Real Claude proxy |
| `ADX_*` | Real ADX ingest (replaces collector stub writer) |

Replace dev-idp M2M URLs with Entra JWKS when moving to production auth (see commented block in `.env.example`).

---

## Seed principals (config store code seed)

| Principal ID | Kind | Project | Allowed models |
|--------------|------|---------|----------------|
| `seed-sp-appid` | sp | `seed-project` | `gpt-5.4`, `claude-opus-4-6` |
| `seed-user-oid` | user | — | `gpt-5-mini`, `claude-haiku-4-5` |

Budget policies are seeded for these principals (monthly cap, hard limit).

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `401` on API | Token audience must be `api://ai-gateway-edge`; mint via dev-idp `:4000/token` |
| `403` model | Model not in principal allowlist (see table above) |
| `429 insufficient_quota` | Redis budget — raise cap in seed or clear Redis: `docker compose exec redis redis-cli FLUSHALL` |
| Collector `batches_written: 0` | Confirm `USAGE_QUEUE=azure` and both gateway + collector share same Azurite connection string |
| Queue errors on startup | Wait for Azurite; queue is auto-created on first enqueue |

---

## Legacy Bun stack

Root `docker-compose.yml` targets the retired Bun gateway (`legacy/`). **Do not use it** for the MVP Node + YARP stack.
