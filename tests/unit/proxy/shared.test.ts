import { beforeEach, describe, expect, test, vi } from 'bun:test';
import { Decimal } from 'decimal.js';
import { redactSensitiveContent, finalizeProxyUsage, releaseReservedQuota } from '@/proxy/shared';
import { ok } from '@/utils/result';

const mockReconcileUsage = vi.fn();
const mockRecordUsageOnly = vi.fn();
const mockReleaseReservation = vi.fn();
const mockLogRequestAudit = vi.fn();
const mockAddLLMSpanAttributes = vi.fn();

vi.mock('../../../src/services/quota.service', () => ({
  reconcileUsage: (...args: unknown[]) => mockReconcileUsage(...args),
  recordUsageOnly: (...args: unknown[]) => mockRecordUsageOnly(...args),
  releaseReservation: (...args: unknown[]) => mockReleaseReservation(...args),
}));

vi.mock('../../../src/db/data-access', () => ({
  logRequestAudit: (...args: unknown[]) => mockLogRequestAudit(...args),
}));

vi.mock('../../../src/observability/tracing', () => ({
  addLLMSpanAttributes: (...args: unknown[]) => mockAddLLMSpanAttributes(...args),
}));

describe('redactSensitiveContent', () => {
  test('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const result = redactSensitiveContent(input);
    expect(result).toBe('Authorization: Bearer [REDACTED]');
  });

  test('redacts JSON key fields', () => {
    const input = '{"key": "secret123", "api_key": "supersecret", "api-key": "alsosecret"}';
    const result = redactSensitiveContent(input);
    expect(result).toBe('{"key":"[REDACTED]", "api_key":"[REDACTED]", "api_key":"[REDACTED]"}');
  });

  test('redacts OpenAI-style API keys (sk-...)', () => {
    const input = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
    const result = redactSensitiveContent(input);
    expect(result).toBe('[API_KEY]');
  });

  test('redacts Azure 32-char hex keys', () => {
    const input = 'abcdef1234567890abcdef1234567890';
    const result = redactSensitiveContent(input);
    expect(result).toBe('[AZURE_KEY]');
  });

  test('preserves OpenAI response IDs (chatcmpl-...)', () => {
    const input = '{"id": "chatcmpl-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz"}';
    const result = redactSensitiveContent(input);
    expect(result).toBe(input);
  });

  test('preserves UUIDs', () => {
    const input = '550e8400-e29b-41d4-a716-446655440000';
    const result = redactSensitiveContent(input);
    expect(result).toBe(input);
  });

  test('preserves short hex strings (<32 chars)', () => {
    const input = 'deadbeef1234567890abcdef1234567';
    const result = redactSensitiveContent(input);
    expect(result).toBe(input);
  });

  test('preserves legitimate JSON hex values like color codes', () => {
    const input = '{"color": "#FF5733", "hex": "0x1A2B3C"}';
    const result = redactSensitiveContent(input);
    expect(result).toBe(input);
  });

  test('preserves 31-char hex strings', () => {
    const input = 'abcdef1234567890abcdef123456789';
    const result = redactSensitiveContent(input);
    expect(result).toBe(input);
  });

  test('redacts multiple sensitive values in one string', () => {
    const input = 'Bearer token123 and sk-abcdefghijklmnopqrstuvwxyz and abcdef1234567890abcdef1234567890';
    const result = redactSensitiveContent(input);
    expect(result).toBe('Bearer [REDACTED] and [API_KEY] and [AZURE_KEY]');
  });
});

describe('finalizeProxyUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseDeployment = {
    name: 'test-deployment',
    azureModelName: 'gpt-5.4',
    protocolFamily: 'chat-completions' as const,
    endpoint: 'https://test.openai.azure.com',
    authConfig: { type: 'api-key' as const, apiKey: 'test-key' },
    modelAlias: 'gpt-5.4',
    modelFamily: 'gpt' as const,
    apiVersion: '2024-02-01',
    enabled: true,
  };

  const baseUsage = {
    prompt_tokens: 10,
    completion_tokens: 5,
    thinking_tokens: 0,
  };

  test('soft-limit path calls recordUsageOnly and logs audit when reservationId is empty', async () => {
    mockRecordUsageOnly.mockResolvedValue(new Decimal('0.002'));
    mockLogRequestAudit.mockResolvedValue(undefined);

    await finalizeProxyUsage({
      usage: baseUsage,
      reservationId: '',
      requestId: 'req-123',
      userId: 'user-1',
      deployment: baseDeployment,
      startTime: Date.now(),
    });

    expect(mockRecordUsageOnly).toHaveBeenCalledTimes(1);
    expect(mockRecordUsageOnly).toHaveBeenCalledWith(
      'user-1',
      baseUsage,
      'gpt-5.4',
      undefined
    );
    expect(mockReconcileUsage).not.toHaveBeenCalled();
    expect(mockLogRequestAudit).toHaveBeenCalledTimes(1);
    expect(mockAddLLMSpanAttributes).toHaveBeenCalledTimes(1);
  });

  test('reservation path calls reconcileUsage and logs audit when reservationId is truthy', async () => {
    mockReconcileUsage.mockResolvedValue(ok(new Decimal('0.003')));
    mockLogRequestAudit.mockResolvedValue(undefined);

    await finalizeProxyUsage({
      usage: baseUsage,
      reservationId: 'res_abc',
      requestId: 'req-456',
      userId: 'user-2',
      deployment: baseDeployment,
      startTime: Date.now(),
    });

    expect(mockReconcileUsage).toHaveBeenCalledTimes(1);
    expect(mockReconcileUsage).toHaveBeenCalledWith(
      'res_abc',
      baseUsage,
      'gpt-5.4'
    );
    expect(mockRecordUsageOnly).not.toHaveBeenCalled();
    expect(mockLogRequestAudit).toHaveBeenCalledTimes(1);
    expect(mockAddLLMSpanAttributes).toHaveBeenCalledTimes(1);
  });

  test('no usage with reservationId releases reservation', async () => {
    await finalizeProxyUsage({
      usage: undefined,
      reservationId: 'res_abc',
      requestId: 'req-789',
      userId: 'user-3',
      deployment: baseDeployment,
      startTime: Date.now(),
    });

    expect(mockReleaseReservation).toHaveBeenCalledTimes(1);
    expect(mockReleaseReservation).toHaveBeenCalledWith('res_abc');
    expect(mockReconcileUsage).not.toHaveBeenCalled();
    expect(mockRecordUsageOnly).not.toHaveBeenCalled();
    expect(mockLogRequestAudit).not.toHaveBeenCalled();
  });

  test('no usage and no reservationId is a no-op', async () => {
    await finalizeProxyUsage({
      usage: undefined,
      reservationId: '',
      requestId: 'req-000',
      userId: 'user-4',
      deployment: baseDeployment,
      startTime: Date.now(),
    });

    expect(mockReleaseReservation).not.toHaveBeenCalled();
    expect(mockReconcileUsage).not.toHaveBeenCalled();
    expect(mockRecordUsageOnly).not.toHaveBeenCalled();
    expect(mockLogRequestAudit).not.toHaveBeenCalled();
  });

  test('soft-limit path uses "unknown" when userId is undefined', async () => {
    mockRecordUsageOnly.mockResolvedValue(new Decimal('0.001'));
    mockLogRequestAudit.mockResolvedValue(undefined);

    await finalizeProxyUsage({
      usage: baseUsage,
      reservationId: '',
      requestId: 'req-111',
      userId: undefined,
      deployment: baseDeployment,
      startTime: Date.now(),
    });

    expect(mockRecordUsageOnly).toHaveBeenCalledWith(
      'unknown',
      baseUsage,
      'gpt-5.4',
      undefined
    );
  });
});
