import { describe, expect, test } from 'bun:test';
import { extractAnthropicUsage, extractOpenAIUsage } from '../../src/utils/streaming';

async function readFixture(path: string): Promise<string> {
  return await Bun.file(`${import.meta.dir}/../fixtures/provider-contracts/${path}`).text();
}

describe('provider contract fixtures', () => {
  test('extracts usage from Azure OpenAI streaming usage chunk fixture', async () => {
    const fixture = await readFixture('azure-openai-chat-stream-usage.sse');

    expect(extractOpenAIUsage(fixture)).toEqual({
      prompt_tokens: 22,
      completion_tokens: 9,
      thinking_tokens: undefined,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: undefined,
    });
  });

  test('extracts usage from Azure AI Foundry Anthropic message_delta fixture', async () => {
    const fixture = await readFixture('azure-foundry-anthropic-stream-usage.sse');

    expect(extractAnthropicUsage(fixture)).toEqual({
      prompt_tokens: 31,
      completion_tokens: 14,
      thinking_tokens: 7,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: undefined,
    });
  });
});
