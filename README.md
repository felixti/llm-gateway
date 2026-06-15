# AI Gateway

Monorepo for an internal AI Gateway: YARP edge + Node.js LLM proxy + usage collector. The live stack lives under `services/{edge,gateway,collector}`, `packages/shared`, and `contracts/`. The retired Bun/Hono gateway is frozen in `legacy/` (read-only reference — [ADR-0015](docs/adr/0015-legacy-bun-app-retirement-reference-and-rewrite.md)).

📝 **What's New?** See [docs/NEWS.md](docs/NEWS.md) for the latest features, improvements, and security updates.

> Glossary and live architecture: [CONTEXT.md](CONTEXT.md). "AI Gateway" = whole repo; "LLM gateway" = `services/gateway`.

## Features

- **Multi-Protocol Support**: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses API
- **PAT Authentication**: HMAC-SHA256 token validation with Redis blocklist, model-scoped tokens (`models:<name>`)
- **Quota Management**: USD-based quota with Redis atomic reservations, Postgres-as-truth reconciler
- **Rate Limiting**: Per-user RPM/TPM with Redis sliding window (fail-closed)
- **Circuit Breaker**: Distributed Redis-backed resilience pattern with fallback chains
- **Streaming**: Real-time usage extraction from SSE streams
- **Observability**: OpenTelemetry traces, Prometheus metrics, structured logging with PII redaction
- **Write-Ahead Log**: Disk-based DLQ for unbilled requests when Redis and PostgreSQL both fail
- **Background Jobs**: Orphan cleanup, monthly archive, quota reconciler with distributed locking
- **Graceful Shutdown**: Connection draining with configurable timeout
- **Security**: CORS, security headers, body size limits, request timeout, admin operator secret
- **Response Caching**: Redis-backed caching for read-only endpoints

## Architecture

See **[CONTEXT.md](CONTEXT.md)** for the live system glossary and topology.

| Topic | Doc |
|-------|-----|
| Monorepo layout (`services/`, `packages/`, `contracts/`, `legacy/`) | [ADR-0014](docs/adr/0014-polyglot-monorepo-vertical-slice-structure.md) |
| Legacy Bun app retirement (`legacy/` read-only) | [ADR-0015](docs/adr/0015-legacy-bun-app-retirement-reference-and-rewrite.md) |
| Local compose stack (edge → gateway → collector) | [deploy/compose/README.md](deploy/compose/README.md) — **`make up` / `make e2e`** |
| Host-native dev (IDE + Docker infra) | [deploy/local/README.md](deploy/local/README.md) |

The sections below describe the **legacy** Bun/Postgres gateway in `legacy/`; they are not the live MVP path.

## Quick Start

### Prerequisites

- Node.js >= 24 (gateway, collector)
- .NET 10 SDK (edge)
- Docker + Docker Compose (recommended for local E2E)

### Local stack (Docker — recommended)

```bash
cp deploy/compose/.env.example deploy/compose/.env
chmod +x deploy/compose/local-up.sh
./deploy/compose/local-up.sh
```

Edge: **http://localhost:8080**. Full env reference: [`deploy/compose/.env.example`](deploy/compose/.env.example).

### Per-service build (host-native)

```bash
git clone https://github.com/your-org/llm-gateway.git
cd llm-gateway

# LLM-domain plane (Node.js 24 / Hono)
cd services/gateway && yarn install && yarn build

# Usage collector (Node.js 24)
cd ../collector && yarn install && yarn build
```

Edge (.NET 10 YARP): build from `services/edge/` — see that directory's README.

### Docker Compose (full local stack)

```bash
docker compose -f deploy/compose/docker-compose.yml up --build
```

Edge listens on **http://localhost:8080**. Details: [deploy/compose/README.md](deploy/compose/README.md).

### Legacy Bun gateway (`legacy/` only)

For the retired Bun/Hono app (Postgres + PAT auth), see `legacy/` and its `.env.example`. Do not use this path for new MVP work.

## API Endpoints

### LLM API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI Chat Completions |
| `/v1/messages` | POST | Anthropic Messages |
| `/v1/messages/count_tokens` | POST | Token counting (Anthropic format) |
| `/v1/responses` | POST | OpenAI Responses API |
| `/v1/models` | GET | List available models |

### Health & Observability

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness probe (always 200) |
| `/ready` | GET | Readiness probe (checks Redis, PostgreSQL, Azure) |
| `/metrics` | GET | Prometheus metrics (optional bearer auth) |
| `/openapi.json` | GET | OpenAPI 3.1 specification |
| `/docs` | GET | Interactive API documentation (Scalar) |

### Quota & Admin

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/quota` | GET | Get quota status |
| `/admin/pat/revoke` | POST | Revoke PAT (requires admin scope) |

## Authentication

### PAT Token Format

```
lg_{userId}_{header}.{payload}.{signature}
```

- **Algorithm**: HMAC-SHA256
- **Scopes**: `all` (full access), `read` (GET/HEAD/OPTIONS only), `admin` (full + `/admin/*`), `models:<name>` (specific model only)
- **Revocation**: Redis blocklist (no TTL, permanent)

### Creating a PAT

```bash
# Using the admin API
curl -X POST http://localhost:3000/admin/pat/create \
  -H "Authorization: Bearer admin-pat" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user123", "scope": "all", "expiresIn": "30d"}'
```

## Quota Management

### How It Works

1. **PostgreSQL is authoritative** for budget policy (`monthly_budget_usd`, `hard_limit`)
2. **Redis is fast path** for real-time enforcement (spent/reserved amounts)
3. **Background reconciler** rebuilds Redis `spent` from PostgreSQL audit logs (1 min interval)
4. **Atomic reservations** via Redis Lua scripts
5. **120% multiplier** for reservation safety margin
6. **300s TTL** for orphan reservation cleanup
7. **Write-Ahead Log** on disk when both Redis and PostgreSQL fail simultaneously

### Quota Headers

| Header | Description |
|--------|-------------|
| `X-Quota-Remaining` | Remaining budget in USD |
| `X-Quota-Reserved` | Reservation ID |
| `X-Warning` | Soft limit warning (if enabled) |

### Soft vs Hard Limits

- **Hard limit**: Returns 429 when quota exceeded
- **Soft limit**: Returns `X-Warning` header, allows request

## Rate Limiting

### Configuration

```bash
RATE_LIMIT_RPM=100      # Requests per minute per user
RATE_LIMIT_TPM=100000   # Tokens per minute per user
```

### Rate Limit Headers

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests per window |
| `X-RateLimit-Remaining` | Remaining requests in window |
| `X-RateLimit-Reset` | Window reset timestamp (Unix) |

## Circuit Breaker

### State Machine

```
CLOSED → OPEN (5 failures)
OPEN → HALF_OPEN (30s timeout)
HALF_OPEN → CLOSED (1 success)
HALF_OPEN → OPEN (1 failure)
```

### Configuration

- **Failure threshold**: 5 failures
- **Reset timeout**: 30 seconds
- **Storage**: Redis (distributed across instances)

## Observability

### OpenTelemetry

Traces, metrics, and logs are exported via OpenTelemetry:

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_GRPC_ENDPOINT=http://localhost:4317
OTEL_SERVICE_NAME=llm-gateway
```

### Custom Span Attributes

| Attribute | Description |
|-----------|-------------|
| `llm.user_id` | User ID |
| `llm.model` | Model name |
| `llm.tokens.input` | Input tokens |
| `llm.tokens.output` | Output tokens |
| `llm.cost.usd` | Cost in USD |

### Metrics

Counters:
- `http_requests_total` - Total HTTP requests
- `llm_tokens_total` - Total LLM tokens
- `llm_cost_usd_total` - Total LLM cost
- `quota_exceeded_429_total` - Quota rejections
- `rate_limit_429_total` - Rate limit rejections

Gauges:
- `llm_quota_remaining_ratio` - Remaining quota ratio
- `circuit_breaker_state` - Circuit breaker state

### Structured Logging

Logs are JSON-formatted with pino:

```json
{
  "level": "info",
  "time": "2026-05-01T17:00:00.000Z",
  "service": "llm-gateway",
  "trace_id": "abc123",
  "user_id": "user123",
  "model": "gpt-4o",
  "tokens": 100,
  "cost_usd": 0.001,
  "duration_ms": 150,
  "status": 200,
  "msg": "Request completed"
}
```

## API Documentation

### Scalar UI

Interactive API documentation is available at `/docs` using Scalar:

```bash
# Start the gateway
bun run dev

# Open documentation
open http://localhost:3000/docs
```

Features:
- Interactive API explorer
- Request/response examples
- Authentication testing
- Schema visualization
- Dark/light theme support

### OpenAPI Specification

The OpenAPI 3.1 specification is available at `/openapi.json`:

```bash
curl http://localhost:3000/openapi.json
```

Use this to:
- Generate client SDKs
- Import into Postman/Insomnia
- Build custom documentation
- Validate API contracts

## Security Headers

- `Strict-Transport-Security`: HSTS with preload
- `X-Frame-Options`: DENY
- `X-Content-Type-Options`: nosniff
- `Referrer-Policy`: no-referrer
- `Cross-Origin-Resource-Policy`: cross-origin

### CORS

Configurable allowed origins:

```bash
CORS_ALLOWED_ORIGINS=https://example.com,https://app.example.com
```

### Body Size Limits

```bash
BODY_SIZE_LIMIT_BYTES=10485760  # 10MB
```

### Request Timeout

```bash
REQUEST_TIMEOUT_MS=30000  # 30 seconds
```

## Graceful Shutdown

### How It Works

1. Receive SIGTERM/SIGINT signal
2. Stop accepting new connections
3. Reject new requests with 503
4. Wait for in-flight requests to complete
5. Close Redis and PostgreSQL connections
6. Exit process

### Configuration

```bash
SHUTDOWN_TIMEOUT_MS=30000  # 30 seconds
```

### Shutdown Headers

During shutdown, responses include:

```json
{
  "error": {
    "message": "Server is shutting down",
    "type": "server_error",
    "code": "shutting_down"
  }
}
```

## Testing

### Unit Tests

```bash
bun run test:unit
```

### Integration Tests

```bash
bun run test:integration
```

### Load Tests

```bash
bun run load:test
```

### Chaos Tests

```bash
bun test tests/chaos
```

### Coverage

```bash
bun run test:coverage
bun run test:coverage:check
```

## Deployment

### Docker

```bash
# Build image
docker build -t llm-gateway .

# Run container
docker run -p 3000:3000 \
  -e AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com \
  -e AZURE_OPENAI_KEY=your-api-key \
  -e DATABASE_URL=postgresql://postgres:postgres@postgres:5432/llm_gateway \
  -e REDIS_HOST=redis \
  -e PAT_SECRET=your-secret-key-at-least-32-characters \
  llm-gateway
```

### Docker Compose

```bash
docker compose up -d
```

Services:
- `gateway` - LLM Gateway (port 3000)
- `redis` - Redis (port 6379)
- `postgres` - PostgreSQL (port 5432)
- `otel-collector` - OpenTelemetry Collector (port 4317)
- `jaeger` - Jaeger UI (port 16686)

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: llm-gateway
spec:
  replicas: 3
  selector:
    matchLabels:
      app: llm-gateway
  template:
    metadata:
      labels:
        app: llm-gateway
    spec:
      containers:
        - name: llm-gateway
          image: llm-gateway:latest
          ports:
            - containerPort: 3000
          env:
            - name: AZURE_OPENAI_ENDPOINT
              valueFrom:
                secretKeyRef:
                  name: llm-gateway-secrets
                  key: azure-openai-endpoint
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
```

## Contributing

### Development Setup

```bash
# Clone repository
git clone https://github.com/your-org/llm-gateway.git
cd llm-gateway

# Install dependencies
bun install

# Start services
docker compose up -d redis postgres

# Run migrations
bun run db:migrate

# Start development server
bun run dev
```

### Code Quality

```bash
# Lint
bun run lint

# Type check
bun run typecheck

# All checks
bun run ci
```

### Commit Convention

We use conventional commits:

```
feat: add new feature
fix: fix bug
docs: update documentation
test: add tests
refactor: refactor code
chore: update dependencies
```

## License

MIT License - see LICENSE file for details.

## Support

- **What's New**: [docs/NEWS.md](docs/NEWS.md)
- **Documentation**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/your-org/llm-gateway/issues)
- **Discussions**: [GitHub Discussions](https://github.com/your-org/llm-gateway/discussions)

## Acknowledgments

- [Bun](https://bun.sh/) - Runtime
- [Hono](https://hono.dev/) - Web framework
- [OpenTelemetry](https://opentelemetry.io/) - Observability
- [Redis](https://redis.io/) - Caching and rate limiting
- [PostgreSQL](https://www.postgresql.org/) - Persistence
