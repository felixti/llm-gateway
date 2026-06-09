import { describe, it, expect } from 'vitest';
import { estimateRequestTokens } from './tokens';

describe('estimateRequestTokens', () => {
  it('uses char/4 + 100 overhead for openai-chat', () => {
    const body = { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] };
    const text = JSON.stringify(body);
    const expected = Math.ceil(text.length / 4) + 100;
    expect(estimateRequestTokens(body, 'openai-chat')).toBe(expected);
  });

  it('applies 1.1x multiplier for anthropic-messages', () => {
    const body = { model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] };
    const text = JSON.stringify(body);
    const base = Math.ceil(text.length / 4) + 100;
    expect(estimateRequestTokens(body, 'anthropic-messages')).toBe(Math.ceil(base * 1.1));
  });

  it('handles minimal body', () => {
    const text = JSON.stringify({});
    expect(estimateRequestTokens({}, 'openai-chat')).toBe(Math.ceil(text.length / 4) + 100);
  });
});
