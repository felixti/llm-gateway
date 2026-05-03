import { describe, expect, test } from 'bun:test';
import { redactSensitiveContent } from '@/proxy/shared';

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
