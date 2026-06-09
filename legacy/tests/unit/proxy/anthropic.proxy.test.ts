import { describe, expect, it, vi, beforeEach, afterEach } from 'bun:test';
import { ok } from '@/utils/result';
import {
  buildUpstreamUrlAnthropic,
  buildUpstreamUrlAnthropicCountTokens,
  extractUsageFromAnthropicEvents,
  proxyCountTokensAnthropic,
  proxyNonStreamingAnthropic,
  proxyStreamingAnthropic,
} from '../../../src/proxy/anthropic.proxy';
import type { DeploymentConfig } from '../../../src/config/deployments';
import { Decimal } from 'decimal.js';

const mockReconcileUsage = vi.fn();
const mockReleaseReservation = vi.fn();
const mockLogRequestAudit = vi.fn();
const mockWithRetry = vi.fn();
const mockRecordFailure = vi.fn();
const mockRecordSuccess = vi.fn();

vi.mock('../../../src/services/quota.service', () => ({
  reconcileUsage: (...args: unknown[]) => mockReconcileUsage(...args),
  releaseReservation: (...args: unknown[]) => mockReleaseReservation(...args),
}));

vi.mock('../../../src/db/data-access', () => ({
  logRequestAudit: (...args: unknown[]) => mockLogRequestAudit(...args),
  insertRequestAuditOrThrow: async (...args: unknown[]) => {
    await mockLogRequestAudit(...args);
    return 'inserted';
  },
}));

vi.mock('../../../src/services/retry', () => ({
  withRetry: (fn: () => unknown) => mockWithRetry(fn),
}));

vi.mock('../../../src/services/circuit-breaker', () => ({
  recordFailure: (...args: unknown[]) => mockRecordFailure(...args),
  recordSuccess: (...args: unknown[]) => mockRecordSuccess(...args),
}));

const baseDeployment: DeploymentConfig = {
  name: 'claude-test',
  modelAlias: 'claude-test',
  modelFamily: 'claude',
  protocolFamily: 'anthropic-messages',
  azureModelName: 'claude-test',
  endpoint: 'https://test.azure.com',
  authConfig: { type: 'api-key', apiKey: 'test-key', keyHeader: 'x-api-key' },
  apiVersion: '2024-06-01',
  enabled: true,
};

describe('Anthropic Proxy', () => {
  describe('buildUpstreamUrlAnthropic', () => {
    it('should build correct URL', () => {
      const deployment = {
        endpoint: 'https://test.azure.com',
        apiVersion: '2024-06-01',
      };
      const url = buildUpstreamUrlAnthropic(deployment as any);
      expect(url).toBe('https://test.azure.com/anthropic/v1/messages?api-version=2024-06-01');
    });
  });

  describe('buildUpstreamUrlAnthropicCountTokens', () => {
    it('should build count_tokens URL with api-version', () => {
      const deployment = {
        endpoint: 'https://test.azure.com',
        apiVersion: '2024-06-01',
      };
      const url = buildUpstreamUrlAnthropicCountTokens(deployment as DeploymentConfig);
      expect(url).toBe(
        'https://test.azure.com/anthropic/v1/messages/count_tokens?api-version=2024-06-01'
      );
    });
  });

  describe('extractUsageFromAnthropicEvents', () => {
    it('should extract usage from message_delta event', () => {
      const events = [
        { type: 'message_start', message: { id: 'msg-1' } },
        {
          type: 'message_delta',
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      ];
      const usage = extractUsageFromAnthropicEvents(events as any);
      expect(usage).not.toBeNull();
      expect(usage!.prompt_tokens).toBe(10);
      expect(usage!.completion_tokens).toBe(20);
    });

    it('should return null when no usage in events', () => {
      const events = [
        { type: 'message_start', message: { id: 'msg-1' } },
        { type: 'content_block_delta', delta: { text: 'hello' } },
      ];
      const usage = extractUsageFromAnthropicEvents(events as any);
      expect(usage).toBeNull();
    });

    it('should return null for empty events', () => {
      const usage = extractUsageFromAnthropicEvents([]);
      expect(usage).toBeNull();
    });
  });

  describe('proxyNonStreamingAnthropic', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
      mockReconcileUsage.mockReset();
      mockReleaseReservation.mockReset();
      mockLogRequestAudit.mockReset();
      mockRecordFailure.mockReset();
      mockRecordSuccess.mockReset();
      mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('releases quota reservation on upstream failure', async () => {
      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'server error' }), { status: 500 })) as unknown as typeof fetch;
      mockReleaseReservation.mockResolvedValue(undefined);

      await proxyNonStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100 },
        baseDeployment,
        { reservationId: 'res-failure', requestId: 'req-failure', userId: 'user-123' } as any
      );

      expect(mockReleaseReservation).not.toHaveBeenCalled();
    });

    it('does not expose upstream error body to clients', async () => {
      global.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'foundry internal details x-api-key=secret-foundry-key prompt=private',
            },
          }),
          { status: 502, headers: { 'content-type': 'application/json' } }
        )) as unknown as typeof fetch;

      const response = await proxyNonStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100 },
        baseDeployment,
        { reservationId: 'res-secret', requestId: 'req-secret', userId: 'user-123' } as any
      );

      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain('Azure AI Foundry upstream request failed with status 502.');
      expect(text).not.toContain('secret-foundry-key');
      expect(text).not.toContain('private');
      expect(text).not.toContain('internal details');
    });

    it('logs authenticated user id in request audit', async () => {
      global.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({ id: 'msg-1', usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          { status: 200 }
        )) as unknown as typeof fetch;
      mockReconcileUsage.mockResolvedValue(ok(new Decimal('0.001')));
      mockLogRequestAudit.mockResolvedValue(undefined);

      await proxyNonStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100 },
        baseDeployment,
        { reservationId: 'res-123', requestId: 'req-123', userId: 'user-123' } as any
      );

      expect(mockLogRequestAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          deployment: 'claude-test',
        })
      );
    });

    it('returns 502 and records circuit breaker failure on upstream network error', async () => {
      global.fetch = vi.fn(async () => {
        throw new Error('Connection refused');
      }) as unknown as typeof fetch;

      const response = await proxyNonStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100 },
        baseDeployment,
        { reservationId: 'res-net', requestId: 'req-net', userId: 'user-123' } as any
      );

      expect(response.status).toBe(502);
      expect(mockRecordFailure).toHaveBeenCalledWith('claude-test');
    });

    it('rethrows abort errors without recording circuit breaker failure', async () => {
      global.fetch = vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }) as unknown as typeof fetch;

      await expect(
        proxyNonStreamingAnthropic(
          'https://test.azure.com/messages',
          {},
          { model: 'claude-test', messages: [], max_tokens: 100 },
          baseDeployment,
          { reservationId: 'res-abort', requestId: 'req-abort', userId: 'user-123' } as any
        )
      ).rejects.toThrow();

      expect(mockRecordFailure).not.toHaveBeenCalled();
    });
  });

  describe('proxyStreamingAnthropic', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
      mockReleaseReservation.mockReset();
      mockReconcileUsage.mockReset();
      mockLogRequestAudit.mockReset();
      mockRecordFailure.mockReset();
      mockRecordSuccess.mockReset();
      mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('releases quota reservation on streaming upstream failure', async () => {
      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'server error' }), { status: 500 })) as unknown as typeof fetch;
      mockReleaseReservation.mockResolvedValue(undefined);

      await proxyStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100 },
        baseDeployment,
        { reservationId: 'res-stream-failure', requestId: 'req-stream-failure', userId: 'user-123' } as any
      );

      expect(mockReleaseReservation).not.toHaveBeenCalled();
    });

    it('does not expose streaming upstream error body to clients', async () => {
      global.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: 'foundry stream failure authorization=Bearer secret-foundry-token',
          }),
          { status: 503, headers: { 'content-type': 'application/json' } }
        )) as unknown as typeof fetch;

      const response = await proxyStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100, stream: true },
        baseDeployment,
        { reservationId: 'res-stream-secret', requestId: 'req-stream-secret', userId: 'user-123' } as any
      );

      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).toContain('Azure AI Foundry upstream request failed with status 503.');
      expect(text).not.toContain('secret-foundry-token');
      expect(text).not.toContain('foundry stream failure');
    });

    it('returns 500 and releases reservation when upstream has no body', async () => {
      global.fetch = vi.fn(async () =>
        new Response(null, { status: 200 })) as unknown as typeof fetch;
      mockReleaseReservation.mockResolvedValue(undefined);

      const response = await proxyStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100 },
        baseDeployment,
        { reservationId: 'res-nobody', requestId: 'req-nobody', userId: 'user-123' } as any
      );

      expect(response.status).toBe(500);
      expect(mockReleaseReservation).toHaveBeenCalledWith('res-nobody');
    });

    it('extracts usage from message_delta event, reconciles, and audits', async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","content":[]}}\n\n'
            )
          );
          controller.enqueue(
            encoder.encode(
              'data: {"type":"message_delta","usage":{"input_tokens":11,"output_tokens":4}}\n\n'
            )
          );
          controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
          controller.close();
        },
      });

      global.fetch = vi.fn(async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch;
      mockReconcileUsage.mockResolvedValue(ok(new Decimal('0.000456')));
      mockLogRequestAudit.mockResolvedValue(undefined);

      const response = await proxyStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100, stream: true },
        baseDeployment,
        { reservationId: 'res-stream-ok', requestId: 'req-stream-ok', userId: 'user-ant' } as any
      );

      expect(response.status).toBe(200);
      await response.text();
      await new Promise((r) => setTimeout(r, 10));

      expect(mockReconcileUsage).toHaveBeenCalledWith(
        'res-stream-ok',
        expect.objectContaining({ prompt_tokens: 11, completion_tokens: 4 }),
        'claude-test'
      );
      expect(mockLogRequestAudit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-ant', deployment: 'claude-test' })
      );
      expect(mockReleaseReservation).not.toHaveBeenCalled();
    });

    it('releases reservation on stream completion without usage event', async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"type":"message_start","message":{"id":"msg-2"}}\n\n')
          );
          controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
          controller.close();
        },
      });

      global.fetch = vi.fn(async () =>
        new Response(body, { status: 200 })) as unknown as typeof fetch;
      mockReleaseReservation.mockResolvedValue(undefined);

      const response = await proxyStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100, stream: true },
        baseDeployment,
        { reservationId: 'res-no-usage', requestId: 'req-no-usage', userId: 'user-ant' } as any
      );

      await response.text();
      await new Promise((r) => setTimeout(r, 10));

      expect(mockReleaseReservation).toHaveBeenCalledWith('res-no-usage');
      expect(mockReconcileUsage).not.toHaveBeenCalled();
    });

    it('success path without usage extracted: non-streaming missing usage releases reservation', async () => {
      // Ensures proxyNonStreamingAnthropic releases on missing usage.
      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ id: 'msg-3', content: [] }), { status: 200 })) as unknown as typeof fetch;
      mockReleaseReservation.mockResolvedValue(undefined);

      const response = await proxyNonStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100 },
        baseDeployment,
        { reservationId: 'res-no-usage-ns', requestId: 'req-no-usage-ns', userId: 'user-ant' } as any
      );

      expect(response.status).toBe(200);
      expect(mockReleaseReservation).toHaveBeenCalledWith('res-no-usage-ns');
      expect(mockReconcileUsage).not.toHaveBeenCalled();
    });

    it('returns 502 and records circuit breaker failure on upstream network error', async () => {
      global.fetch = vi.fn(async () => {
        throw new Error('Connection refused');
      }) as unknown as typeof fetch;

      const response = await proxyStreamingAnthropic(
        'https://test.azure.com/messages',
        {},
        { model: 'claude-test', messages: [], max_tokens: 100, stream: true },
        baseDeployment,
        { reservationId: 'res-net', requestId: 'req-net', userId: 'user-123' } as any
      );

      expect(response.status).toBe(502);
      expect(mockRecordFailure).toHaveBeenCalledWith('claude-test');
    });

    it('rethrows abort errors without recording circuit breaker failure', async () => {
      global.fetch = vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }) as unknown as typeof fetch;

      await expect(
        proxyStreamingAnthropic(
          'https://test.azure.com/messages',
          {},
          { model: 'claude-test', messages: [], max_tokens: 100, stream: true },
          baseDeployment,
          { reservationId: 'res-abort', requestId: 'req-abort', userId: 'user-123' } as any
        )
      ).rejects.toThrow();

      expect(mockRecordFailure).not.toHaveBeenCalled();
    });
  });

  describe('proxyCountTokensAnthropic', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
      mockRecordFailure.mockReset();
      mockRecordSuccess.mockReset();
      mockWithRetry.mockImplementation((fn: () => unknown) => fn());
      mockReconcileUsage.mockReset();
      mockReleaseReservation.mockReset();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('POSTs JSON to upstream count_tokens and forwards anthropic-beta', async () => {
      global.fetch = vi.fn(async (input, init) => {
        expect(String(input)).toContain('/messages/count_tokens');
        expect(init?.method).toBe('POST');

        const headers = init?.headers;
        let anthropicVersion: string | undefined;
        let anthropicBeta: string | undefined;
        let contentType: string | undefined;
        if (headers instanceof Headers) {
          anthropicVersion = headers.get('anthropic-version') ?? undefined;
          anthropicBeta = headers.get('anthropic-beta') ?? undefined;
          contentType = headers.get('content-type') ?? undefined;
        } else if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
          const record = headers as Record<string, string>;
          anthropicVersion = Object.entries(record).find(
            ([k]) => k.toLowerCase() === 'anthropic-version'
          )?.[1];
          anthropicBeta = Object.entries(record).find(
            ([k]) => k.toLowerCase() === 'anthropic-beta'
          )?.[1];
          contentType = Object.entries(record).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
        }

        expect(anthropicVersion).toBe('2023-06-01');
        expect(anthropicBeta).toBe('token-counting-2024-11-01');
        expect(contentType).toBe('application/json');

        return new Response(JSON.stringify({ input_tokens: 99 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const response = await proxyCountTokensAnthropic(
        'https://test.azure.com/anthropic/v1/messages/count_tokens?api-version=2024-06-01',
        { 'x-api-key': 'k' },
        { beta: 'token-counting-2024-11-01', version: '2023-06-01' },
        { model: 'claude-test', messages: [{ role: 'user', content: 'Hi' }] },
        baseDeployment,
        { requestId: 'req-ct', userId: 'user-ct', abortSignal: new AbortController().signal }
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ input_tokens: 99 });
      expect(mockRecordSuccess).toHaveBeenCalledWith('claude-test');
      expect(mockRecordFailure).not.toHaveBeenCalled();
      expect(mockReconcileUsage).not.toHaveBeenCalled();
      expect(mockReleaseReservation).not.toHaveBeenCalled();
    });

    it('sanitizes upstream errors for count_tokens path', async () => {
      global.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'upstream-secret-key=x-api-key-leaked details',
            },
          }),
          { status: 502, headers: { 'content-type': 'application/json' } }
        )) as unknown as typeof fetch;

      const response = await proxyCountTokensAnthropic(
        'https://test.azure.com/anthropic/v1/messages/count_tokens?api-version=2024-06-01',
        {},
        {},
        { model: 'claude-test', messages: [{ role: 'user', content: 'Hi' }] },
        baseDeployment,
        { requestId: 'req-ct-err', userId: 'user-ct', abortSignal: new AbortController().signal }
      );

      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain('Azure AI Foundry upstream request failed');
      expect(text).not.toContain('x-api-key-leaked');
      expect(mockRecordFailure).toHaveBeenCalledWith('claude-test');
      expect(mockReleaseReservation).not.toHaveBeenCalled();
    });

    it('returns 502 and records circuit breaker failure on upstream network error', async () => {
      global.fetch = vi.fn(async () => {
        throw new Error('Connection refused');
      }) as unknown as typeof fetch;

      const response = await proxyCountTokensAnthropic(
        'https://test.azure.com/anthropic/v1/messages/count_tokens?api-version=2024-06-01',
        {},
        {},
        { model: 'claude-test', messages: [{ role: 'user', content: 'Hi' }] },
        baseDeployment,
        { requestId: 'req-ct-net', userId: 'user-ct', abortSignal: new AbortController().signal }
      );

      expect(response.status).toBe(502);
      expect(mockRecordFailure).toHaveBeenCalledWith('claude-test');
    });

    it('rethrows abort errors without recording circuit breaker failure', async () => {
      global.fetch = vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }) as unknown as typeof fetch;

      await expect(
        proxyCountTokensAnthropic(
          'https://test.azure.com/anthropic/v1/messages/count_tokens?api-version=2024-06-01',
          {},
          {},
          { model: 'claude-test', messages: [{ role: 'user', content: 'Hi' }] },
          baseDeployment,
          { requestId: 'req-ct-abort', userId: 'user-ct', abortSignal: new AbortController().signal }
        )
      ).rejects.toThrow();

      expect(mockRecordFailure).not.toHaveBeenCalled();
    });
  });
});
