import { describe, expect, it, vi } from 'bun:test';
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
  recordHttpRequestDuration,
  recordLlmRequestDuration,
  getPrometheusMetrics,
  llmTokensTotal,
} from '@/observability/metrics';

describe('Metrics', () => {
  it('should increment HTTP requests', () => {
    expect(() => {
      incrementHttpRequests('GET', '/test', 200);
      incrementHttpRequests('POST', '/test', 201);
    }).not.toThrow();
  });

  it('should add LLM tokens', () => {
    expect(() => {
      addLlmTokens(100, 200, 'gpt-4o');
      addLlmTokens(50, 50, 'claude-3.5-sonnet');
    }).not.toThrow();
  });

  it('normalizes model labels before recording LLM token metrics', () => {
    const calls: Array<[number, Record<string, string>]> = [];
    const originalAdd = llmTokensTotal.add;
    llmTokensTotal.add = ((value: number, attributes: Record<string, string>) => {
      calls.push([value, attributes]);
    }) as typeof llmTokensTotal.add;

    try {
      addLlmTokens(100, 200, 'gpt-5.4-experimental-user-supplied');
    } finally {
      llmTokensTotal.add = originalAdd;
    }

    expect(calls[0][1].model).toBe('gpt');
    expect(calls[1][1].model).toBe('gpt');
  });

  it('should add LLM cost', () => {
    expect(() => {
      addLlmCost(1.5, 'gpt-4o');
      addLlmCost(0.5, 'claude-3.5-sonnet');
    }).not.toThrow();
  });

  it('should increment Azure rate limit hits', () => {
    expect(() => {
      incrementAzureRateLimitHits();
      incrementAzureRateLimitHits();
    }).not.toThrow();
  });

  it('should increment operational counters', () => {
    expect(() => {
      incrementQuotaHydrationFailures();
      incrementQuotaExceeded429();
      incrementRateLimit429();
      incrementPatRevocationsTotal();
    }).not.toThrow();
  });

  it('should set quota remaining ratio', () => {
    expect(() => {
      setQuotaRemainingRatio(0.5);
      setQuotaRemainingRatio(1.5);
      setQuotaRemainingRatio(-0.5);
    }).not.toThrow();
  });

  it('should set circuit breaker state', () => {
    expect(() => {
      setCircuitBreakerState('CLOSED');
      setCircuitBreakerState('OPEN');
      setCircuitBreakerState('HALF_OPEN');
    }).not.toThrow();
  });

  it('should record HTTP request duration', () => {
    expect(() => {
      recordHttpRequestDuration(150, 'GET', '/test');
      recordHttpRequestDuration(250, 'POST', '/v1/chat/completions');
    }).not.toThrow();
  });

  it('should record LLM request duration', () => {
    expect(() => {
      recordLlmRequestDuration(1500, 'gpt-4o', 'openai');
      recordLlmRequestDuration(2000, 'claude-3.5-sonnet', 'anthropic');
    }).not.toThrow();
  });

  it('should expose gauges and histograms in Prometheus output', () => {
    setQuotaRemainingRatio(0.42);
    setCircuitBreakerState('OPEN');
    recordHttpRequestDuration(123, 'GET', '/v1/models');
    recordLlmRequestDuration(456, 'gpt-5.4', 'chat-completions');

    const output = getPrometheusMetrics();

    expect(output).toContain('# TYPE llm_quota_remaining_ratio gauge');
    expect(output).toContain('llm_quota_remaining_ratio 0.42');
    expect(output).toContain('# TYPE circuit_breaker_state gauge');
    expect(output).toContain('circuit_breaker_state 1');
    expect(output).toContain('# TYPE http_request_duration_ms histogram');
    expect(output).toContain('http_request_duration_ms_bucket{le="100"');
    expect(output).toContain('http_request_duration_ms_bucket{le="+Inf"');
    expect(output).toContain('http_request_duration_ms_count');
    expect(output).toContain('# TYPE llm_request_duration_ms histogram');
    expect(output).toContain('llm_request_duration_ms_bucket{le="1000"');
    expect(output).toContain('llm_request_duration_ms_bucket{le="+Inf"');
    expect(output).toContain('llm_request_duration_ms_count');
  });
});

describe('finalizeProxyUsage metrics integration', () => {
  it('should import metrics functions used by finalizeProxyUsage', async () => {
    const proxyShared = await import('@/proxy/shared');
    expect(typeof proxyShared.finalizeProxyUsage).toBe('function');

    const metrics = await import('@/observability/metrics');
    expect(typeof metrics.addLlmTokens).toBe('function');
    expect(typeof metrics.addLlmCost).toBe('function');
    expect(typeof metrics.recordLlmRequestDuration).toBe('function');
  });
});
