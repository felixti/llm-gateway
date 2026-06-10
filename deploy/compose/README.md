# Docker Compose — full local AI Gateway stack

Runs **edge → gateway → collector** with **dev-idp**, **Redis**, and **Azurite** — no Azure account required.

For host-native (IDE) development, see [`deploy/local/README.md`](../local/README.md).

## Quick start

```bash
make env    # once: copy .env.example → .env
make up     # build + start (detached)
make e2e    # smoke tests (stack must be running)
```

Or use the shell wrappers directly:

```bash
cp deploy/compose/.env.example deploy/compose/.env   # defaults work out of the box
chmod +x deploy/compose/local-up.sh deploy/compose/local-e2e.sh
./deploy/compose/local-up.sh
```

From the repo root, `make help` lists all automation targets (`make chat`, `make codex`, `make smoke`, …).

| Endpoint | URL |
|----------|-----|
| API (via edge) | http://localhost:8080 |
| dev-idp (mint tokens) | http://localhost:4000 |
| Collector health | http://localhost:4100/health |
| Azurite queue | localhost:10001 |

## Stack

| Service | Role |
|---------|------|
| `dev-idp` | Local OIDC-ish issuer + JWKS (replaces Entra in dev) |
| `edge` | .NET 9 YARP — validates client JWT, forwards M2M + claims |
| `gateway` | Node 24 — auth, tenant, budget, rate-limit, stub LLM routes |
| `collector` | Drains usage queue → JSON batches (stub ADX) |
| `redis` | Live budget + RPM/TPM counters |
| `azurite` | Azure Storage Queue (+ Table/Blob) emulator |
| `e2e` | Optional profile — smoke tests through edge |

## Environment

All variables are documented in [`.env.example`](.env.example). Copy to `.env`:

```bash
cp .env.example .env
```

**Fully local defaults** (no edits needed):

- `USAGE_QUEUE=azure` + Azurite connection string (gateway and collector share the queue)
- `CONFIG_STORE=memory` (code seed for models/tenancy/budget policy)
- `M2M_*` aligned with `dev-idp` and `yarp-compose-dev` app id

**Fill only when leaving local stubs** — see the "Azure production" section in `.env.example`.

## Manual request

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/token \
  -H 'content-type: application/json' \
  -d '{"audience":"api://ai-gateway-edge","claims":{"appid":"seed-sp-appid","idtyp":"app","roles":"proj1"}}' \
  | jq -r .access_token)

curl -X POST http://localhost:8080/v1/chat/completions \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"hello"}]}'
```

## Seed principals

| Principal ID | Kind | Allowed models |
|--------------|------|----------------|
| `seed-sp-appid` | sp | all five (see seed) |
| `seed-user-oid` | user | `gpt-4.1`, `gpt-5-mini`, `Kimi-K2.5` |
| `app1` (proj1 role) | sp | `gpt-4.1`, `DeepSeek-V4-Flash`, `Kimi-K2.5` |

See [`MODELS.my-ms-aif.md`](MODELS.my-ms-aif.md) for Azure endpoint mapping.

## Auth modes

- **Compose** (`Auth:Mode=compose-dev`): `dev-idp` JWKS — local/docker only.
- **Entra** (production `appsettings.json`): real `Microsoft.Identity.Web` validation.

## Usage pipeline (local)

1. Gateway commits budget → emits `UsageEvent` → Azurite queue  
2. On enqueue failure → WAL under `WAL_DIR` → replayer retries  
3. Collector polls queue → writes `batch-*.json` to `collector-out` volume  

Inspect batches:

```bash
docker compose -f deploy/compose/docker-compose.yml exec collector ls -la /data/out
```

## Commands

```bash
# From repo root (recommended)
make up          # start detached
make e2e         # smoke tests
make chat        # quick LLM call (MODEL=, MSG=)
make down        # stop

# Or compose directly from this directory
./local-up.sh -d
./local-e2e.sh
docker compose --env-file .env -f docker-compose.yml logs -f gateway edge
docker compose --env-file .env -f docker-compose.yml down
docker compose --env-file .env -f docker-compose.yml down -v   # reset volumes
```

## Legacy Bun stack

Root `docker-compose.yml` targets the retired Bun gateway in `legacy/`. Use **this** compose file for the MVP Node + YARP stack.
