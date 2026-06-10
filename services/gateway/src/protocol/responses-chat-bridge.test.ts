import { describe, expect, it } from 'vitest';
import {
  adaptRequestBody,
  adaptResponseBody,
  transformChatCompletionsToResponses,
  transformResponsesToChatCompletions,
  transformResponsesToChatCompletionsResponse,
} from './responses-chat-bridge';

describe('responses-chat-bridge', () => {
  it('maps chat completions request to Responses API for codex upstream', () => {
    const upstream = adaptRequestBody('openai-chat', 'responses', {
      model: 'gpt-5.1-codex-mini',
      messages: [{ role: 'user', content: 'Write a function' }],
      reasoning_effort: 'high',
    });

    expect(upstream.model).toBe('gpt-5.1-codex-mini');
    expect(upstream.input).toBe('Write a function');
    expect(upstream.reasoning).toEqual({ effort: 'high' });
  });

  it('maps Responses API upstream body back to chat completions contract', () => {
    const chat = adaptResponseBody('openai-chat', 'responses', {
      id: 'resp_123',
      created_at: 1_700_000_000,
      model: 'gpt-5.1-codex-mini',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'function add(a,b){ return a+b; }' }],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 18, total_tokens: 30 },
    });

    expect(chat.object).toBe('chat.completion');
    expect(chat.choices).toHaveLength(1);
    expect((chat.choices as unknown[])[0]).toMatchObject({
      message: { role: 'assistant', content: 'function add(a,b){ return a+b; }' },
      finish_reason: 'stop',
    });
    expect(chat.usage).toEqual({
      input_tokens: 12,
      output_tokens: 18,
      total_tokens: 30,
    });
  });

  it('maps /v1/responses client body to chat upstream for gpt-4.1', () => {
    const upstream = transformResponsesToChatCompletions({
      model: 'gpt-4.1',
      input: 'hello',
    });
    expect(upstream.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('maps tool calls both directions', () => {
    const responsesReq = transformChatCompletionsToResponses({
      model: 'gpt-5.1-codex-mini',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file text' },
      ],
    });

    expect(responsesReq.input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"a.ts"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'file text' },
    ]);

    const chatResp = transformResponsesToChatCompletionsResponse({
      id: 'resp_tools',
      model: 'gpt-5.1-codex-mini',
      output: [
        {
          type: 'function_call',
          call_id: 'call_9',
          name: 'grep',
          arguments: '{"pattern":"foo"}',
        },
      ],
    });

    expect(chatResp.choices).toEqual([
      expect.objectContaining({
        finish_reason: 'tool_calls',
        message: expect.objectContaining({
          tool_calls: [
            expect.objectContaining({
              id: 'call_9',
              function: { name: 'grep', arguments: '{"pattern":"foo"}' },
            }),
          ],
        }),
      }),
    ]);
  });
});
