import { describe, expect, it, vi, beforeEach, afterEach } from 'bun:test';
import {
  buildUpstreamUrlAnthropic,
  extractUsageFromAnthropicEvents,
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

      expect(mockReleaseReservation).toHaveBeenCalledWith('res-failure');
    });

    it('logs authenticated user id in request audit', async () => {
      global.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({ id: 'msg-1', usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          { status: 200 }
        )) as unknown as typeof fetch;
      mockReconcileUsage.mockResolvedValue(new Decimal('0.001'));
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

      expect(mockReleaseReservation).toHaveBeenCalledWith('res-stream-failure');
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
      mockReconcileUsage.mockResolvedValue(new Decimal('0.000456'));
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
  });
});
