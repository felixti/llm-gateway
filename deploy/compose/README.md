# Docker Compose — MVP M0 E2E

Runs the full **edge → gateway** trust boundary locally without Azure Entra.

## Stack

| Service   | Role |
|-----------|------|
| `dev-idp` | Local OIDC-ish issuer + JWKS for client and M2M tokens |
| `gateway` | Node 24 Hono API (stub chat/messages routes) |
| `edge`    | .NET 9 YARP — validates client JWT, forwards claims + M2M token |
| `e2e`     | Optional profile — smoke tests through edge |

## Quick start

```bash
# Build and start edge + gateway + dev-idp
docker compose -f deploy/compose/docker-compose.yml up --build

# In another terminal — run E2E checks
docker compose -f deploy/compose/docker-compose.yml --profile e2e run --rm e2e
```

Edge listens on **http://localhost:8080** (override with `EDGE_PORT` in `.env`).

## Manual request

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/token \
  -H 'content-type: application/json' \
  -d '{"audience":"api://ai-gateway-edge","claims":{"appid":"seed-sp-appid","idtyp":"app","roles":"proj1"}}' \
  | jq -r .access_token)

curl -X POST http://localhost:8080/v1/chat/completions \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4","messages":[]}'
```

> `dev-idp` is not published by default (internal network only). Use the `e2e` profile or `docker compose exec dev-idp wget -qO- http://localhost:4000/health` for debugging.

## Seed principals (M0 static allowlist)

| Principal ID      | Kind | Allowed models |
|-------------------|------|----------------|
| `seed-sp-appid`   | sp   | `gpt-5.4`, `claude-opus-4-6` |
| `seed-user-oid`   | user | `gpt-5-mini`, `claude-haiku-4-5` |

## Auth modes

- **Compose** (`Auth:Mode=compose-dev`): uses `dev-idp` JWKS — for local/docker only.
- **Entra** (default in `appsettings.json`): production `Microsoft.Identity.Web` validation.

## Legacy Bun stack

The root `docker-compose.yml` still targets the old Bun gateway (Redis/Postgres/OTel). Use this compose file for the MVP Node + YARP stack.
