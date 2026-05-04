import { env } from '@/config/env';
import { resolveOtlpHttpMetricsUrl } from '@/observability/otlp-http-url';
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

let meterProvider: MeterProvider | null = null;

function normalizePath(path: string): string {
  if (path === '/v1/chat/completions') return '/v1/chat/completions';
  if (path === '/v1/messages') return '/v1/messages';
  if (path === '/v1/messages/count_tokens' || path === '/count_tokens') {
    return '/v1/messages/count_tokens';
  }
  if (path === '/v1/responses') return '/v1/responses';
  if (path === '/v1/models') return '/v1/models';
  if (path === '/health') return '/health';
  if (path === '/ready') return '/ready';
  if (path === '/metrics') return '/metrics';
  if (path === '/quota/status') return '/quota/status';
  if (path.startsWith('/admin/')) return '/admin/*';
  return '/other';
}

const inMemoryCounters: Record<string, number> = {
  http_requests_total: 0,
  llm_tokens_total: 0,
  llm_cost_usd_total: 0,
  azure_rate_limit_hits_total: 0,
  quota_hydration_failures_total: 0,
  quota_exceeded_429_total: 0,
  rate_limit_429_total: 0,
  pat_revocations_total: 0,
  quota_orphan_cleaned_total: 0,
  quota_reservation_null_total: 0,
  unbilled_requests_total: 0,
  fallback_soft_overage_total: 0,
};

const inMemoryGauges: Record<string, number> = {
  llm_quota_remaining_ratio: 0,
  circuit_breaker_state: 0,
};

const inMemoryHistograms: Record<string, { count: number; sum: number }> = {
  http_request_duration_ms: { count: 0, sum: 0 },
  llm_request_duration_ms: { count: 0, sum: 0 },
};

function incrementCounter(name: string, value = 1): void {
  inMemoryCounters[name] = (inMemoryCounters[name] || 0) + value;
}

export function getPrometheusMetrics(): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(inMemoryCounters)) {
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  }
  for (const [name, value] of Object.entries(inMemoryGauges)) {
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }
  for (const [name, value] of Object.entries(inMemoryHistograms)) {
    lines.push(`# TYPE ${name} histogram`);
    lines.push(`${name}_count ${value.count}`);
    lines.push(`${name}_sum ${value.sum}`);
  }
  return lines.join('\n');
}

function createMetricExporter(): OTLPMetricExporter | null {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return null;
  }
  return new OTLPMetricExporter({
    url: resolveOtlpHttpMetricsUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT),
  });
}

export function initMetrics(): void {
  if (meterProvider) {
    return;
  }

  const exporter = createMetricExporter();
  if (!exporter) {
    return;
  }

  meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 15_000,
      }),
    ],
  });

  metrics.setGlobalMeterProvider(meterProvider);
}

export async function shutdownMetrics(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = null;
  }
}

const meter = metrics.getMeter('llm-gateway');

const METRIC_MODEL_FAMILIES = ['gpt', 'claude', 'kimi', 'glm', 'minimax'] as const;

function normalizeMetricModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  const family = METRIC_MODEL_FAMILIES.find(
    (candidate) => normalized === candidate || normalized.startsWith(`${candidate}-`)
  );
  return family ?? 'other';
}

export const httpRequestsTotal = meter.createCounter('http_requests_total', {
  description: 'Total number of HTTP requests',
});

export const llmTokensTotal = meter.createCounter('llm_tokens_total', {
  description: 'Total number of LLM tokens processed',
});

export const llmCostUsdTotal = meter.createCounter('llm_cost_usd_total', {
  description: 'Total LLM cost in USD',
});

export const azureRateLimitHitsTotal = meter.createCounter('azure_rate_limit_hits_total', {
  description: 'Total Azure rate limit hits',
});

export const quotaHydrationFailuresTotal = meter.createCounter('quota_hydration_failures_total', {
  description: 'Postgres quota policy sync failures',
});

export const quotaExceeded429Total = meter.createCounter('quota_exceeded_429_total', {
  description: 'Gateway quota rejections (HTTP 429)',
});

export const rateLimit429Total = meter.createCounter('rate_limit_429_total', {
  description: 'Rate limit rejections (HTTP 429)',
});

export const patRevocationsTotal = meter.createCounter('pat_revocations_total', {
  description: 'PAT revocation requests recorded',
});

export const unbilledRequestsTotal = meter.createCounter('unbilled_requests_total', {
  description: 'Requests that completed without successful billing (WAL written)',
});

export const fallbackSoftOverageTotal = meter.createCounter('fallback_soft_overage_total', {
  description: 'Fallback chain top-ups that exceeded hard budget on soft-limit accounts',
});

export const llmQuotaRemainingRatio = meter.createGauge('llm_quota_remaining_ratio', {
  description: 'Remaining quota ratio (0-1)',
});

export const circuitBreakerState = meter.createGauge('circuit_breaker_state', {
  description: 'Circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)',
});

export const httpRequestDuration = meter.createHistogram('http_request_duration_ms', {
  description: 'HTTP request duration in milliseconds',
  unit: 'ms',
});

export const llmRequestDuration = meter.createHistogram('llm_request_duration_ms', {
  description: 'LLM request duration in milliseconds',
  unit: 'ms',
});

/** @internal */
export function incrementHttpRequests(method: string, path: string, status: number): void {
  const normalized = normalizePath(path);
  httpRequestsTotal.add(1, { method, path: normalized, status: String(status) });
  incrementCounter('http_requests_total');
}

export function addLlmTokens(promptTokens: number, completionTokens: number, model: string): void {
  const metricModel = normalizeMetricModel(model);
  llmTokensTotal.add(promptTokens, { type: 'input', model: metricModel });
  llmTokensTotal.add(completionTokens, { type: 'output', model: metricModel });
  incrementCounter('llm_tokens_total', promptTokens + completionTokens);
}

export function addLlmCost(costUsd: number, model: string): void {
  llmCostUsdTotal.add(costUsd, { model: normalizeMetricModel(model) });
  incrementCounter('llm_cost_usd_total', costUsd);
}

export function incrementQuotaHydrationFailures(): void {
  quotaHydrationFailuresTotal.add(1);
  incrementCounter('quota_hydration_failures_total');
}

export function incrementQuotaExceeded429(): void {
  quotaExceeded429Total.add(1);
  incrementCounter('quota_exceeded_429_total');
}

export function incrementRateLimit429(): void {
  rateLimit429Total.add(1);
  incrementCounter('rate_limit_429_total');
}

export function incrementPatRevocationsTotal(): void {
  patRevocationsTotal.add(1);
  incrementCounter('pat_revocations_total');
}

export function incrementAzureRateLimitHits(): void {
  azureRateLimitHitsTotal.add(1);
  incrementCounter('azure_rate_limit_hits_total');
}

export function incrementQuotaOrphanCleaned(): void {
  incrementCounter('quota_orphan_cleaned_total');
}

export function incrementQuotaReservationNull(): void {
  incrementCounter('quota_reservation_null_total');
}

export function incrementUnbilledRequests(reason: 'redis_fail' | 'pg_fail' | 'both_fail'): void {
  unbilledRequestsTotal.add(1, { reason });
  incrementCounter('unbilled_requests_total');
}

export function incrementFallbackSoftOverage(model: string): void {
  fallbackSoftOverageTotal.add(1, { model: normalizeMetricModel(model) });
  incrementCounter('fallback_soft_overage_total');
}

/** @internal */
export function setQuotaRemainingRatio(ratio: number): void {
  const clamped = Math.max(0, Math.min(1, ratio));
  llmQuotaRemainingRatio.record(clamped);
  inMemoryGauges.llm_quota_remaining_ratio = clamped;
}

export function setCircuitBreakerState(state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void {
  const value = state === 'CLOSED' ? 0 : state === 'OPEN' ? 1 : 2;
  circuitBreakerState.record(value);
  inMemoryGauges.circuit_breaker_state = value;
}

export function recordHttpRequestDuration(durationMs: number, method: string, path: string): void {
  const normalized = normalizePath(path);
  httpRequestDuration.record(durationMs, { method, path: normalized });
  inMemoryHistograms.http_request_duration_ms.count++;
  inMemoryHistograms.http_request_duration_ms.sum += durationMs;
}

export function recordLlmRequestDuration(
  durationMs: number,
  model: string,
  protocol: string
): void {
  llmRequestDuration.record(durationMs, { model: normalizeMetricModel(model), protocol });
  inMemoryHistograms.llm_request_duration_ms.count++;
  inMemoryHistograms.llm_request_duration_ms.sum += durationMs;
}
