import { describe, expect, it } from 'bun:test';
import {
  resolveOtlpHttpMetricsUrl,
  resolveOtlpHttpTracesUrl,
} from '../../../src/observability/otlp-http-url';

describe('otlp-http-url', () => {
  it('appends /v1/traces for base URL', () => {
    expect(resolveOtlpHttpTracesUrl('http://collector:4318')).toBe('http://collector:4318/v1/traces');
  });

  it('preserves full traces URL', () => {
    expect(resolveOtlpHttpTracesUrl('http://collector:4318/v1/traces')).toBe(
      'http://collector:4318/v1/traces'
    );
  });

  it('maps metrics URL to traces sibling', () => {
    expect(resolveOtlpHttpTracesUrl('http://collector:4318/v1/metrics')).toBe(
      'http://collector:4318/v1/traces'
    );
  });

  it('appends /v1/metrics for base URL', () => {
    expect(resolveOtlpHttpMetricsUrl('http://collector:4318')).toBe('http://collector:4318/v1/metrics');
  });

  it('maps traces URL to metrics sibling', () => {
    expect(resolveOtlpHttpMetricsUrl('http://collector:4318/v1/traces')).toBe(
      'http://collector:4318/v1/metrics'
    );
  });
});
