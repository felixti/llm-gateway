import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  estimateTokens,
  estimateMessagesTokens,
  estimateAnthropicTokens,
} from '../../../src/utils/tokens';

describe('Token Estimation - edge cases', () => {
  describe('estimateTokens', () => {
    it('handles empty string input', () => {
      expect(estimateTokens('', 'gpt-5.4')).toBe(0);
    });

    it('handles single character', () => {
      const tokens = estimateTokens('a', 'gpt-5.4');
      expect(tokens).toBeGreaterThan(0);
    });

    it('handles unicode text', () => {
      const tokens = estimateTokens('你好世界 🎉', 'gpt-5.4');
      expect(tokens).toBeGreaterThan(0);
    });

    it('applies claude multiplier correctly', () => {
      const text = 'Hello, this is a test message for token estimation.';
      const gptTokens = estimateTokens(text, 'gpt-5.4');
      const claudeTokens = estimateTokens(text, 'claude-opus-4-6');
      expect(claudeTokens).toBeGreaterThanOrEqual(Math.ceil(gptTokens * 1.1));
    });

    it('does not apply thinking buffer for non-claude with thinkingEnabled', () => {
      const text = 'Some test text here.';
      const withoutThinking = estimateTokens(text, 'gpt-5.4', { thinkingEnabled: false });
      const withThinking = estimateTokens(text, 'gpt-5.4', { thinkingEnabled: true });
      expect(withThinking).toBe(withoutThinking);
    });

    it('applies both claude multiplier and thinking buffer', () => {
      const text = 'Testing claude with thinking enabled.';
      const base = estimateTokens(text, 'claude-opus-4-6');
      const withThinking = estimateTokens(text, 'claude-opus-4-6', { thinkingEnabled: true });
      expect(withThinking).toBe(Math.ceil(base * 1.2));
    });
  });

  describe('estimateMessagesTokens', () => {
    it('returns 0 for null-like messages', () => {
      expect(estimateMessagesTokens([], 'gpt-5.4')).toBe(0);
    });

    it('handles messages with empty content', () => {
      const messages = [{ role: 'user', content: '' }];
      const tokens = estimateMessagesTokens(messages, 'gpt-5.4');
      expect(tokens).toBeGreaterThanOrEqual(0);
    });

    it('adds 4 tokens overhead per message', () => {
      const one = [{ role: 'user', content: 'hello' }];
      const two = [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'hello' },
      ];

      const oneTokens = estimateMessagesTokens(one, 'gpt-5.4');
      const twoTokens = estimateMessagesTokens(two, 'gpt-5.4');

      expect(twoTokens - oneTokens).toBeGreaterThanOrEqual(4);
    });
  });

  describe('estimateAnthropicTokens', () => {
    it('handles null/undefined content gracefully', () => {
      const messages = [{ role: 'user', content: undefined as unknown as string }];
      const tokens = estimateAnthropicTokens(messages, 'claude-opus-4-6');
      expect(tokens).toBeGreaterThanOrEqual(0);
    });

    it('handles array content blocks', () => {
      const messages = [
        {
          role: 'user' as const,
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image', data: 'base64...' },
          ] as unknown as string,
        },
      ];
      const tokens = estimateAnthropicTokens(messages, 'claude-opus-4-6');
      expect(tokens).toBeGreaterThan(0);
    });

    it('applies thinking for claude models', () => {
      const messages = [{ role: 'user', content: 'hello' }];
      const normal = estimateAnthropicTokens(messages, 'claude-opus-4-6', false);
      const thinking = estimateAnthropicTokens(messages, 'claude-opus-4-6', true);
      expect(thinking).toBeGreaterThan(normal);
    });

    it('does not apply thinking for non-claude models', () => {
      const messages = [{ role: 'user', content: 'hello' }];
      const normal = estimateAnthropicTokens(messages, 'gpt-5.4', false);
      const thinking = estimateAnthropicTokens(messages, 'gpt-5.4', true);
      expect(thinking).toBe(normal);
    });
  });
});
