# LLM Gateway Architecture

An LLM API proxy server built in **Bun/Hono** that proxies requests to Azure OpenAI and Azure AI Foundry endpoints.

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              LLM Gateway                                        │
│                                                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐ │
│  │ Request  │──▶│   Auth   │──▶│ Protocol │──▶│  Rate   │──▶│  Quota   │ │
│  │    ID   │   │   PAT    │   │  Guard   │   │  Limit   │   │          │ │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘ │
│                                                                   │            │
│                                                                   ▼            │
│                                                    ┌─────────────────────────┐ │
│                                                    │   Request Handler       │ │
│                                                    │      Factory            │ │
│                                                    └─────────────────────────┘ │
│                                                                   │            │
│         ┌───────────────────────┬───────────────────────┬───────┘            │
│         ▼                       ▼                       ▼                      │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐                │
│  │    OpenAI    │      │  Anthropic   │      │  Responses   │                │
│  │    Chat      │      │  Messages    │      │     API      │                │
│  └──────┬───────┘      └──────┬───────┘      └──────┬───────┘                │
│         │                     │                     │                          │
│         ▼                     ▼                     ▼                          │
│  ┌─────────────────────────────────────────────────────────┐                  │
│  │              Proxy Layer (Retry + Circuit Breaker)       │                  │
│  └─────────────────────────────────────────────────────────┘                  │
│                              │                                                │
└──────────────────────────────┼────────────────────────────────────────────────┘
                               │
                               ▼
              ┌───────────────────────────────────────┐
              │        Azure OpenAI / AI Foundry       │
              └───────────────────────────────────────┘
```

## Infrastructure

```mermaid
graph TB
    subgraph Client
        APP[HTTP Client]
    end

    subgraph Infrastructure
        GW[LLM Gateway<br/>:3000]
        REDIS[Redis<br/>:6379]
        PG[PostgreSQL<br/>:5432]
        OTEL[OTEL Collector<br/>:4317-4318]
        JAEGER[Jaeger UI<br/>:16686]
    end

    subgraph Upstream
        AZURE_OPENAI[Azure OpenAI<br/>GPT Models]
        FOUNDRY[Azure AI Foundry<br/>Claude/Kimi/GLM/MiniMax]
    end

    APP --> GW
    GW --> REDIS
    GW --> PG
    GW --> OTEL
    OTEL --> JAEGER
    GW --> AZURE_OPENAI
    GW --> FOUNDRY
```

## Request Flow

```mermaid
sequenceDiagram
    participant Client
    participant Gateway as LLM Gateway
    participant Redis
    participant PostgreSQL
    participant Azure as Azure AI

    Client->>Gateway: POST /v1/chat/completions<br/>Authorization: Bearer lg_...

    Note over Gateway: 1. request-id.ts<br/>Generate UUID, set X-Request-Id

    Gateway->>Gateway: 2. auth.ts<br/>Validate PAT token
    Gateway->>Redis: Check blocklist:pat:{hash(jti)}
    Redis-->>Gateway: Not found

    Note over Gateway: 3. protocol-guard.ts<br/>Map model → deployment

    Gateway->>Gateway: 4. rate-limit.ts<br/>Sliding window RPM/TPM

    Gateway->>Redis: Increment rate counter
    Redis-->>Gateway: OK

    Note over Gateway: 5. quota.ts<br/>Estimate tokens, reserve quota

    Gateway->>Redis: ZADD quota:{user}:{month}
    Redis-->>Gateway: Reserved

    Note over Gateway: 6. Route Handler<br/>Zod validation, deployment lookup

    Gateway->>Gateway: 7. Circuit Breaker<br/>Check isRequestAllowed()

    Gateway->>Azure: Proxy request
    Azure-->>Gateway: Stream response

    Gateway->>Client: SSE stream with usage

    Note over Gateway: On completion:<br/>reconcileUsage() or<br/>releaseReservation()
```

## Middleware Chain

```mermaid
flowchart LR
    subgraph Middleware["Middleware Chain"]
        direction TB
        R1["Request ID<br/>UUID generation"]
        R2["Auth (PAT)<br/>Blocklist check"]
        R3["Protocol Guard<br/>Model → Endpoint"]
        R4["Rate Limit<br/>RPM / TPM"]
        R5["Quota<br/>Reserve / Release"]
        R6["Route Handler"]
    end

    Request --> R1 --> R2 --> R3 --> R4 --> R5 --> R6 --> Response
```

### Middleware Details

| Middleware | File | Responsibility |
|------------|------|----------------|
| Request ID | `request-id.ts` | Generate UUID v4, set `X-Request-Id` header |
| Auth | `auth.ts` | Validate PAT `lg_{userId}_{header}.{payload}.{signature}`, check Redis blocklist |
| Protocol Guard | `protocol-guard.ts` | Validate model-endpoint compatibility |
| Rate Limit | `rate-limit.ts` | Sliding window via Redis sorted sets |
| Quota | `quota.ts` | Token estimation, 120% cost reservation, 429 on hard limit |

## Route Handlers

```mermaid
flowchart TD
    subgraph Routes
        CHAT["/v1/chat/completions<br/>chat.routes.ts"]
        MSG["/v1/messages<br/>messages.routes.ts"]
        RESP["/v1/responses<br/>responses.routes.ts"]
        MODELS["/v1/models<br/>models.routes.ts"]
        HEALTH["/health<br/>health.routes.ts"]
        QUOTA["/quota<br/>quota.routes.ts"]
        ADMIN["/admin<br/>admin.routes.ts"]
    end

    subgraph Factory["Request Handler Factory"]
        PARSE["Parse JSON body"]
        VALIDATE["Zod schema validation"]
        DEPLOY["Deployment lookup"]
        CIRCUIT["Circuit breaker check"]
        AUTH["Auth headers (Azure)"]
        PROXY["Streaming / Non-streaming"]
    end

    CHAT --> Factory
    MSG --> Factory
    RESP --> Factory
```

### Protocol Routing

| Route | Protocol | Models |
|-------|----------|--------|
| `/v1/chat/completions` | OpenAI Chat Completions | GPT-4o, GPT-4o-Mini, Kimi, GLM, MiniMax |
| `/v1/messages` | Anthropic Messages | Claude-3.5-Sonnet, Claude-3.7-Sonnet |
| `/v1/responses` | OpenAI Responses API | GPT-4o, GPT-4o-Mini |

## Service Architecture

```mermaid
graph TB
    subgraph Proxy["Proxy Layer"]
        OA["openai-chat.proxy"]
        AN["anthropic.proxy"]
        OR["openai-responses.proxy"]
    end

    subgraph Services["Service Layer"]
        CB["Circuit Breaker<br/>5 failures → OPEN<br/>30s reset → HALF_OPEN"]
        RETRY["Retry<br/>1s, 2s, 4s, 8s<br/>±1s jitter"]
        QUOTA["Quota Service<br/>Atomic Redis ops<br/>120% reservation"]
        PRICING["Pricing Service<br/>decimal.js<br/>Hot-reload pricing.json"]
        HEALTH["Health Service<br/>Periodic checks"]
    end

    subgraph Auth["Authentication"]
        AZ["AzureAuthManager<br/>API Key / Entra ID<br/>Token caching"]
    end

    subgraph Data["Data Layer"]
        REDIS["Redis<br/>Rate limit, Quota,<br/>Blocklist, Token cache"]
        PG["PostgreSQL<br/>Audit logging"]
    end

    OA --> CB --> RETRY --> AZ --> REDIS
    AN --> CB --> RETRY --> AZ --> REDIS
    OR --> CB --> RETRY --> AZ --> REDIS
```

## Circuit Breaker State Machine

```mermaid
stateDiagram-v2
    [*] --> CLOSED
    CLOSED --> OPEN: 5 failures
    OPEN --> HALF_OPEN: 30s timeout
    HALF_OPEN --> CLOSED: 1 success
    HALF_OPEN --> OPEN: 1 failure
    OPEN --> [*]
    CLOSED --> [*]
```

## Deployment Registry

```mermaid
flowchart LR
    subgraph Deployments["Deployment Registry (deployments.ts)"]
        GPT["GPT-4o-Mini<br/>Azure OpenAI<br/>api-key auth"]
        CLAUDE["Claude-3.5-Sonnet<br/>AI Foundry<br/>Entra ID"]
        KIMI["Kimi-K2.5<br/>AI Foundry<br/>Entra ID"]
        GLM["GLM-5<br/>AI Foundry<br/>Entra ID"]
        MINI["MiniMax-M2.5<br/>AI Foundry<br/>Entra ID"]
    end

    subgraph Endpoints
        AZ_OPENAI["Azure OpenAI<br/>openai/deployments/{name}"]
        FOUNDRY["AI Foundry<br/>/models/chat/completions"]
    end

    GPT --> AZ_OPENAI
    CLAUDE --> FOUNDRY
    KIMI --> FOUNDRY
    GLM --> FOUNDRY
    MINI --> FOUNDRY
```

## Quota Management

```mermaid
flowchart TB
    subgraph Reserve["Quota Reservation Flow"]
        EST["Estimate tokens<br/>tiktoken + 20% buffer"]
        COST["Calculate cost<br/>pricing × 1.2 multiplier"]
        CHECK["Check budget<br/>spent + reserved + cost"]
        RESERVE["Reserve in Redis<br/>120% multiplier<br/>300s orphan TTL"]
    end

    subgraph Release["Quota Release Flow"]
        DONE["On completion<br/>reconcileUsage()"]
        ERROR["On error/abort<br/>releaseReservation()"]
        CLEANUP["Orphan cleanup<br/>300s TTL"]
    end

    EST --> COST --> CHECK --> RESERVE
    RESERVE --> DONE
    RESERVE --> ERROR
    ERROR --> CLEANUP
```

## Observability

```mermaid
graph LR
    subgraph Collection
        TRACES["OpenTelemetry Traces<br/>Custom spans"]
        LOGS["Pino JSON Logs<br/>PII sanitization"]
        METRICS["Counters/Gauges"]
    end

    subgraph Export
        OTEL["OTEL Collector<br/>:4317 gRPC<br/>:4318 HTTP"]
        JAEGER["Jaeger<br/>:16686 UI"]
    end

    TRACES --> OTEL
    LOGS --> OTEL
    METRICS --> OTEL
    OTEL --> JAEGER
```

### Custom Trace Spans

| Span Attribute | Description |
|----------------|-------------|
| `llm.user_id` | PAT user identifier |
| `llm.model` | Model name |
| `llm.tokens.prompt` | Estimated prompt tokens |
| `llm.tokens.completion` | Estimated completion tokens |
| `llm.cost.usd` | Estimated cost in USD |

## File Structure

```
src/
├── config/
│   ├── env.ts           # Zod environment validation
│   ├── deployments.ts   # 8 model deployments
│   └── pricing.json     # Per-model pricing (hot-reload)
├── middleware/
│   ├── request-id.ts    # UUID generation
│   ├── auth.ts          # PAT authentication
│   ├── protocol-guard.ts # Model-endpoint validation
│   ├── rate-limit.ts    # Redis rate limiting
│   └── quota.ts         # Quota reservation
├── services/
│   ├── azure-auth.ts    # Entra ID + API Key auth
│   ├── circuit-breaker.ts
│   ├── retry.ts
│   ├── pricing.service.ts
│   ├── quota.service.ts
│   └── health.service.ts
├── proxy/
│   ├── openai-chat.proxy.ts
│   ├── anthropic.proxy.ts
│   └── openai-responses.proxy.ts
├── routes/
│   ├── chat.routes.ts
│   ├── messages.routes.ts
│   ├── responses.routes.ts
│   ├── models.routes.ts
│   ├── health.routes.ts
│   ├── quota.routes.ts
│   ├── admin.routes.ts
│   └── factories/       # Request handler factory
├── utils/
│   ├── errors.ts        # Protocol-aware errors
│   ├── tokens.ts        # Token estimation
│   ├── streaming.ts     # SSE parsing
│   ├── result.ts        # Result[T, E] type
│   └── functional.ts    # pipe/compose helpers
├── observability/
│   ├── tracing.ts       # OpenTelemetry
│   ├── logger.ts        # Pino structured logging
│   └── metrics.ts
├── db/
│   ├── migration.sql
│   └── data-access.ts
└── index.ts             # Hono app bootstrap
```

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Bun |
| Framework | Hono |
| Validation | Zod |
| Rate Limit / Quota | Redis |
| Audit Log | PostgreSQL |
| Tracing | OpenTelemetry + Jaeger |
| Logging | Pino |
| Pricing | decimal.js |
| Token Estimation | tiktoken |
