# LLM Gateway

A production-ready API proxy server for Azure OpenAI and Azure AI Foundry endpoints, built with Bun/Hono.

📝 **What's New?** See [docs/NEWS.md](docs/NEWS.md) for the latest features, improvements, and security updates.

## Features

- **Multi-Protocol Support**: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses API
- **PAT Authentication**: HMAC-SHA256 token validation with Redis blocklist
- **Quota Management**: USD-based quota with Redis atomic reservations
- **Rate Limiting**: Per-user RPM/TPM with Redis sliding window
- **Circuit Breaker**: Distributed Redis-backed resilience pattern
- **Streaming**: Real-time usage extraction from SSE streams
- **Observability**: OpenTelemetry traces, metrics, and structured logging
- **Graceful Shutdown**: Connection draining with configurable timeout
- **Security**: CORS, security headers, body size limits, request timeout

## Quick Start

### Prerequisites

- Bun >= 1.0.0
- Redis >= 7.0
- PostgreSQL >= 16
- Azure OpenAI or AI Foundry account

### Installation

```bash
git clone https://github.com/your-org/llm-gateway.git
cd llm-gateway
bun install
```

### Configuration

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Required environment variables:

```bash
# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_KEY=your-api-key

# Azure AI Foundry (optional)
AZURE_AI_FOUNDRY_ENDPOINT=https://your-resource.services.ai.azure.com
AZURE_AI_FOUNDRY_KEY=your-api-key

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# PostgreSQL
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/llm_gateway

# PAT Secret (min 32 characters)
PAT_SECRET=your-secret-key-at-least-32-characters

# Security
CORS_ALLOWED_ORIGINS=*
BODY_SIZE_LIMIT_BYTES=10485760
REQUEST_TIMEOUT_MS=30000
SHUTDOWN_TIMEOUT_MS=30000
```

### Running

```bash
# Development
bun run dev

# Production
bun run start

# With Docker
docker compose up -d
```

### Database Setup

```bash
# Run migrations
psql -U postgres -d llm_gateway -f migrations/001_initial_schema.sql
psql -U postgres -d llm_gateway -f migrations/002_pat_subject.sql
```

## API Endpoints

### LLM API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI Chat Completions |
| `/v1/messages` | POST | Anthropic Messages |
| `/v1/responses` | POST | OpenAI Responses API |
| `/v1/models` | GET | List available models |

### Health & Observability

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness probe (always 200) |
| `/ready` | GET | Readiness probe (checks Redis, PostgreSQL, Azure) |
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
- **Scopes**: `all`, `read`, `admin`
- **Revocation**: Redis blocklist (no TTL)

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
3. **Atomic reservations** via Redis Lua scripts
4. **120% multiplier** for reservation safety margin
5. **300s TTL** for orphan reservation cleanup

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
