import { describe, expect, it } from 'bun:test';
import {
  buildUpstreamUrlAnthropic,
  extractUsageFromAnthropicEvents,
} from '../../../src/proxy/anthropic.proxy';

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
});
