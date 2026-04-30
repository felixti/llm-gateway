import { describe, expect, it, beforeEach } from 'bun:test';
import {
  incrementHttpRequests,
  addLlmTokens,
  addLlmCost,
  incrementAzureRateLimitHits,
  incrementQuotaHydrationFailures,
  incrementQuotaExceeded429,
  incrementRateLimit429,
  incrementPatRevocationsTotal,
  setQuotaRemainingRatio,
  setCircuitBreakerState,
  getMetrics,
  resetMetrics,
  trackRequest,
  getPrometheusMetrics,
} from '@/observability/metrics';

describe('Metrics', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('should increment HTTP requests', () => {
    incrementHttpRequests('GET', '/test', 200);
    incrementHttpRequests('POST', '/test', 201);
    const m = getMetrics();
    expect(m.http_requests_total).toBe(2);
  });

  it('should add LLM tokens', () => {
    addLlmTokens(100, 200);
    addLlmTokens(50, 50);
    const m = getMetrics();
    expect(m.llm_tokens_total).toBe(400);
  });

  it('should add LLM cost', () => {
    addLlmCost(1.5);
    addLlmCost(0.5);
    const m = getMetrics();
    expect(m.llm_cost_usd_total).toBe(2);
  });

  it('should increment Azure rate limit hits', () => {
    incrementAzureRateLimitHits();
    incrementAzureRateLimitHits();
    const m = getMetrics();
    expect(m.azure_rate_limit_hits_total).toBe(2);
  });

  it('should increment operational counters', () => {
    incrementQuotaHydrationFailures();
    incrementQuotaExceeded429();
    incrementRateLimit429();
    incrementPatRevocationsTotal();
    const m = getMetrics();
    expect(m.quota_hydration_failures_total).toBe(1);
    expect(m.quota_exceeded_429_total).toBe(1);
    expect(m.rate_limit_429_total).toBe(1);
    expect(m.pat_revocations_total).toBe(1);
  });

  it('should set quota remaining ratio clamped to 0-1', () => {
    setQuotaRemainingRatio(0.5);
    expect(getMetrics().llm_quota_remaining_ratio).toBe(0.5);

    setQuotaRemainingRatio(1.5);
    expect(getMetrics().llm_quota_remaining_ratio).toBe(1);

    setQuotaRemainingRatio(-0.5);
    expect(getMetrics().llm_quota_remaining_ratio).toBe(0);
  });

  it('should set circuit breaker state', () => {
    setCircuitBreakerState('CLOSED');
    expect(getMetrics().circuit_breaker_state).toBe(0);

    setCircuitBreakerState('OPEN');
    expect(getMetrics().circuit_breaker_state).toBe(1);

    setCircuitBreakerState('HALF_OPEN');
    expect(getMetrics().circuit_breaker_state).toBe(2);
  });

  it('should track request with tokens and cost', () => {
    trackRequest('POST', '/v1/chat/completions', 200, { prompt: 100, completion: 200 }, 1.23);
    const m = getMetrics();
    expect(m.http_requests_total).toBe(1);
    expect(m.llm_tokens_total).toBe(300);
    expect(m.llm_cost_usd_total).toBe(1.23);
  });

  it('should track request without tokens or cost', () => {
    trackRequest('GET', '/health', 200);
    const m = getMetrics();
    expect(m.http_requests_total).toBe(1);
    expect(m.llm_tokens_total).toBe(0);
    expect(m.llm_cost_usd_total).toBe(0);
  });

  it('should return Prometheus-formatted metrics', () => {
    incrementHttpRequests('GET', '/test', 200);
    addLlmTokens(10, 20);
    addLlmCost(0.5);
    incrementAzureRateLimitHits();
    setQuotaRemainingRatio(0.75);
    setCircuitBreakerState('CLOSED');

    const prom = getPrometheusMetrics();
    expect(prom).toContain('http_requests_total 1');
    expect(prom).toContain('llm_tokens_total 30');
    expect(prom).toContain('llm_cost_usd_total 0.5');
    expect(prom).toContain('azure_rate_limit_hits_total 1');
    expect(prom).toContain('quota_hydration_failures_total 0');
    expect(prom).toContain('quota_exceeded_429_total 0');
    expect(prom).toContain('rate_limit_429_total 0');
    expect(prom).toContain('pat_revocations_total 0');
    expect(prom).toContain('llm_quota_remaining_ratio 0.75');
    expect(prom).toContain('circuit_breaker_state 0');
  });

  it('should reset all metrics', () => {
    incrementHttpRequests('GET', '/test', 200);
    addLlmTokens(100, 200);
    addLlmCost(1.5);
    incrementAzureRateLimitHits();
    setQuotaRemainingRatio(0.5);
    setCircuitBreakerState('OPEN');

    resetMetrics();
    const m = getMetrics();
    expect(m.http_requests_total).toBe(0);
    expect(m.llm_tokens_total).toBe(0);
    expect(m.llm_cost_usd_total).toBe(0);
    expect(m.azure_rate_limit_hits_total).toBe(0);
    expect(m.quota_hydration_failures_total).toBe(0);
    expect(m.quota_exceeded_429_total).toBe(0);
    expect(m.rate_limit_429_total).toBe(0);
    expect(m.pat_revocations_total).toBe(0);
    expect(m.llm_quota_remaining_ratio).toBe(1);
    expect(m.circuit_breaker_state).toBe(0);
  });
});
