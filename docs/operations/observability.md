# Observability, SLOs, and alerting

## Endpoints

| Path | Purpose |
|------|---------|
| `GET /` | Liveness — process is up |
| `GET /ready` | Dependencies (Redis, Postgres, deployments) |
| `GET /metrics` | Prometheus text format |

## Metrics (from `src/observability/metrics.ts`)

### Counters

| Metric | Meaning |
|---|---|
| `http_requests_total` | All HTTP requests served |
| `llm_tokens_total` | Sum of prompt + completion tokens reconciled |
| `llm_cost_usd_total` | Sum of reconciled USD cost |
| `azure_rate_limit_hits_total` | Upstream Azure 429s observed |
| `quota_hydration_failures_total` | Postgres → Redis policy sync failures |
| `quota_exceeded_429_total` | Gateway-side 429s caused by quota |
| `rate_limit_429_total` | Gateway-side 429s caused by rate limit |
| `pat_revocations_total` | PAT revocations recorded by `/admin/pat/revoke` |

### Gauges

| Metric | Range | Meaning |
|---|---|---|
| `llm_quota_remaining_ratio` | 0–1 | Last reported `remaining/budget` |
| `circuit_breaker_state` | 0/1/2 | CLOSED / OPEN / HALF_OPEN |

## Tracing

OpenTelemetry exports OTLP/gRPC when `OTEL_EXPORTER_OTLP_GRPC_ENDPOINT` is set. Sampler is a deterministic trace-id-hash ratio sampler at **10%** (typed `Sampler`, no `as any`). Custom span attributes (`src/observability/tracing.ts`):

- `llm.user_id`, `llm.model`, `llm.deployment`
- `llm.tokens.input`, `llm.tokens.output`, `llm.tokens.thinking`, `llm.tokens.total`
- `llm.cost.usd`
- `llm.protocol`, `azure.auth_type`

Trace context is propagated to Azure via W3C `traceparent` plus `x-ms-client-request-id`.

## Suggested SLOs

| SLI | Target | Window |
|---|---|---|
| Gateway availability (`/ready` returns 200) | 99.9% | 30 d rolling |
| p95 proxy latency for non-streaming requests | < 2× upstream p95 | 7 d rolling |
| Successful reconciliation rate (200 with usage / 200) | ≥ 99% | 7 d rolling |
| Postgres hydration success | ≥ 99.9% | 24 h rolling |

## Alert rules (Prometheus-style sketches)

```yaml
groups:
  - name: llm-gateway
    rules:
      - alert: QuotaHydrationFailing
        expr: increase(quota_hydration_failures_total[10m]) > 5
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "Postgres → Redis quota sync failing"
          runbook: "docs/operations/runbook-quota-drift.md"

      - alert: CircuitBreakerOpen
        expr: circuit_breaker_state == 1
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "Upstream circuit breaker open"
          runbook: ".context/docs/runbook.md#3-circuit-breaker-open-for-all-deployments"

      - alert: HighGatewayQuota429s
        expr: increase(quota_exceeded_429_total[15m]) > 50
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "Many users hitting their quota"
          runbook: "docs/operations/runbook-quota-drift.md"

      - alert: HighRateLimit429s
        expr: increase(rate_limit_429_total[5m]) > 100
        for: 5m
        labels: { severity: warning }

      - alert: UpstreamRateLimited
        expr: increase(azure_rate_limit_hits_total[5m]) > 20
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Azure upstream is rate-limiting us"

      - alert: PatRevocationSpike
        expr: increase(pat_revocations_total[10m]) > 5
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "Unusual PAT revocation activity — possible incident"
          runbook: "docs/operations/runbook-pat-rotation.md"
```

## Suggested Grafana dashboard panels

1. **Gateway request rate** — `rate(http_requests_total[1m])` split by status class.
2. **Token volume & cost** — `rate(llm_tokens_total[5m])`, `rate(llm_cost_usd_total[5m])`.
3. **429 breakdown** — `rate(quota_exceeded_429_total[5m])` vs `rate(rate_limit_429_total[5m])` vs `rate(azure_rate_limit_hits_total[5m])`.
4. **Circuit breaker state** — `circuit_breaker_state` as a state-timeline panel per deployment.
5. **Quota headroom** — `llm_quota_remaining_ratio` heatmap over user cohorts.
6. **Postgres hydration health** — `rate(quota_hydration_failures_total[5m])`.
7. **Security** — `rate(pat_revocations_total[1h])`, plus 401 rate from `http_requests_total`.

## Logging

Structured JSON via pino. Always emit `requestId`, `userId` (when authenticated), and the OpenTelemetry `traceId`. **Never** log message bodies — only metadata. Sanitization for emails/token prefixes is enforced in `src/observability/logger.ts` (see unit tests).
