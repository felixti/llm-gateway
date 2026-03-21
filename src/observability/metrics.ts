/**
 * Metrics Service
 * Counters, Gauges, and Histograms for observability
 */

// Metric counters
let httpRequestsTotal = 0;
let llmTokensTotal = 0;
let llmCostUsdTotal = 0;
let azureRateLimitHitsTotal = 0;

// Gauges
let llmQuotaRemainingRatio = 1.0;
let circuitBreakerState = 0; // 0=CLOSED, 1=OPEN, 2=HALF_OPEN

/**
 * Increment HTTP request counter
 */
export function incrementHttpRequests(
  _method: string,
  _path: string,
  _status: number
): void {
  httpRequestsTotal++;
}

/**
 * Add LLM tokens to counter
 */
export function addLlmTokens(promptTokens: number, completionTokens: number): void {
  llmTokensTotal += promptTokens + completionTokens;
}

/**
 * Add LLM cost to counter (USD)
 */
export function addLlmCost(costUsd: number): void {
  llmCostUsdTotal += costUsd;
}

/**
 * Increment Azure rate limit hits counter
 */
export function incrementAzureRateLimitHits(): void {
  azureRateLimitHitsTotal++;
}

/**
 * Set quota remaining ratio gauge
 */
export function setQuotaRemainingRatio(ratio: number): void {
  llmQuotaRemainingRatio = Math.max(0, Math.min(1, ratio));
}

/**
 * Set circuit breaker state gauge
 * 0 = CLOSED, 1 = OPEN, 2 = HALF_OPEN
 */
export function setCircuitBreakerState(state: "CLOSED" | "OPEN" | "HALF_OPEN"): void {
  switch (state) {
    case "CLOSED":
      circuitBreakerState = 0;
      break;
    case "OPEN":
      circuitBreakerState = 1;
      break;
    case "HALF_OPEN":
      circuitBreakerState = 2;
      break;
  }
}

/**
 * Get all current metrics
 */
export function getMetrics(): {
  http_requests_total: number;
  llm_tokens_total: number;
  llm_cost_usd_total: number;
  azure_rate_limit_hits_total: number;
  llm_quota_remaining_ratio: number;
  circuit_breaker_state: number;
} {
  return {
    http_requests_total: httpRequestsTotal,
    llm_tokens_total: llmTokensTotal,
    llm_cost_usd_total: llmCostUsdTotal,
    azure_rate_limit_hits_total: azureRateLimitHitsTotal,
    llm_quota_remaining_ratio: llmQuotaRemainingRatio,
    circuit_breaker_state: circuitBreakerState,
  };
}

/**
 * Reset all metrics (for testing)
 */
export function resetMetrics(): void {
  httpRequestsTotal = 0;
  llmTokensTotal = 0;
  llmCostUsdTotal = 0;
  azureRateLimitHitsTotal = 0;
  llmQuotaRemainingRatio = 1.0;
  circuitBreakerState = 0;
}

/**
 * Create middleware-compatible request tracking
 */
export function trackRequest(
  method: string,
  path: string,
  status: number,
  tokens?: { prompt: number; completion: number },
  cost?: number
): void {
  incrementHttpRequests(method, path, status);

  if (tokens) {
    addLlmTokens(tokens.prompt, tokens.completion);
  }

  if (cost !== undefined) {
    addLlmCost(cost);
  }
}

/**
 * Get metrics formatted for Prometheus scraping
 */
export function getPrometheusMetrics(): string {
  const m = getMetrics();
  return `# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total ${m.http_requests_total}

# HELP llm_tokens_total Total number of LLM tokens processed
# TYPE llm_tokens_total counter
llm_tokens_total ${m.llm_tokens_total}

# HELP llm_cost_usd_total Total LLM cost in USD
# TYPE llm_cost_usd_total counter
llm_cost_usd_total ${m.llm_cost_usd_total}

# HELP azure_rate_limit_hits_total Total Azure rate limit hits
# TYPE azure_rate_limit_hits_total counter
azure_rate_limit_hits_total ${m.azure_rate_limit_hits_total}

# HELP llm_quota_remaining_ratio Remaining quota ratio (0-1)
# TYPE llm_quota_remaining_ratio gauge
llm_quota_remaining_ratio ${m.llm_quota_remaining_ratio}

# HELP circuit_breaker_state Circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)
# TYPE circuit_breaker_state gauge
circuit_breaker_state ${m.circuit_breaker_state}
`;
}
