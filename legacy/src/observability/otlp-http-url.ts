/**
 * Normalize OTLP HTTP/protobuf exporter URLs from a single base or full signal URL.
 * Collector OTLP HTTP typically listens on port 4318 with paths `/v1/traces` and `/v1/metrics`.
 */
export function resolveOtlpHttpTracesUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/$/, '');
  if (trimmed.endsWith('/v1/traces')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1/metrics')) {
    return `${trimmed.replace(/\/v1\/metrics$/, '')}/v1/traces`;
  }
  return `${trimmed}/v1/traces`;
}

export function resolveOtlpHttpMetricsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/$/, '');
  if (trimmed.endsWith('/v1/metrics')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1/traces')) {
    return `${trimmed.replace(/\/v1\/traces$/, '')}/v1/metrics`;
  }
  return `${trimmed}/v1/metrics`;
}
