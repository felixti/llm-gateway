import { describe, expect, it, beforeEach, afterEach, vi } from 'bun:test';
import {
  initTracing,
  shutdownTracing,
  getCurrentTraceId,
  getTracer,
  addLLMSpanAttributes,
  recordError,
  injectTraceContext,
  withSpan,
  ATTR_LLM_USER_ID,
  ATTR_LLM_MODEL,
  ATTR_LLM_DEPLOYMENT,
  ATTR_LLM_TOKENS_INPUT,
  ATTR_LLM_TOKENS_OUTPUT,
  ATTR_LLM_TOKENS_THINKING,
  ATTR_LLM_COST_USD,
  ATTR_LLM_PROTOCOL,
  ATTR_AZURE_AUTH_TYPE,
  createLoggingTraceExporterForTests,
} from '../../../src/observability/tracing';

const warnEntries: unknown[] = [];

vi.mock('../../../src/observability/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => warnEntries.push(args),
    error: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  },
}));

describe('Tracing', () => {
  beforeEach(() => {
    warnEntries.length = 0;
  });

  beforeEach(() => {
    initTracing();
  });

  afterEach(async () => {
    await shutdownTracing();
  });

  describe('initTracing / shutdownTracing', () => {
    it('should initialize without errors', () => {
      expect(() => initTracing()).not.toThrow();
    });

    it('should shutdown without errors', async () => {
      initTracing();
      await expect(shutdownTracing()).resolves.toBeUndefined();
    });
  });

  describe('OTLP exporter warnings', () => {
    it('logs a warning when trace export fails', async () => {
      const exporter = createLoggingTraceExporterForTests({
        export: (_spans, callback) => {
          callback({ code: 1, error: new Error('collector unavailable') });
        },
        shutdown: async () => undefined,
      });

      exporter.export([], () => undefined);
      await Promise.resolve();

      expect(JSON.stringify(warnEntries)).toContain('Trace export failed');
      expect(JSON.stringify(warnEntries)).toContain('collector unavailable');
    });
  });

  describe('getCurrentTraceId', () => {
    it('should return null when no active span', () => {
      expect(getCurrentTraceId()).toBeNull();
    });
  });

  describe('getTracer', () => {
    it('should return a tracer instance', () => {
      const tracer = getTracer('test');
      expect(tracer).toBeDefined();
    });
  });

  describe('addLLMSpanAttributes', () => {
    it('should not throw when no active span', () => {
      expect(() =>
        addLLMSpanAttributes({
          userId: 'user1',
          model: 'gpt-5.4',
          deployment: 'gpt-5.4-global',
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          costUsd: 0.01,
          protocol: 'openai',
          authType: 'api-key',
        })
      ).not.toThrow();
    });

    it('accepts thinking token attributes for OpenTelemetry spans', () => {
      expect(() =>
        addLLMSpanAttributes({
          thinkingTokens: 7,
        })
      ).not.toThrow();
    });
  });

  describe('recordError', () => {
    it('should not throw when no active span', () => {
      expect(() => recordError(new Error('test'))).not.toThrow();
    });
  });

  describe('injectTraceContext', () => {
    it('should inject x-ms-client-request-id', () => {
      const headers = injectTraceContext({ 'Content-Type': 'application/json' }, 'req-123');
      expect(headers['x-ms-client-request-id']).toBe('req-123');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should preserve existing headers', () => {
      const headers = injectTraceContext({ Authorization: 'Bearer test' }, 'req-456');
      expect(headers.Authorization).toBe('Bearer test');
      expect(headers['x-ms-client-request-id']).toBe('req-456');
    });
  });

  describe('withSpan', () => {
    it('should wrap operation with span and return result', async () => {
      const result = await withSpan('test.span', async () => 'success');
      expect(result).toBe('success');
    });

    it('should set attributes on span', async () => {
      const result = await withSpan(
        'test.span',
        async () => 'success',
        { 'test.key': 'test.value' }
      );
      expect(result).toBe('success');
    });

    it('should record error on exception', async () => {
      await expect(
        withSpan('test.span', async () => {
          throw new Error('span error');
        })
      ).rejects.toThrow('span error');
    });
  });
});
