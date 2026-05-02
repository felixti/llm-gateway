import { describe, expect, test } from 'bun:test';
import { chatCompletionsBodySchema } from '@/routes/chat.routes';

describe('chatCompletionsBodySchema passthrough', () => {
  const validBase = {
    model: 'gpt-4o',
    messages: [{ role: 'user' as const, content: 'hello' }],
  };

  test('passes through unknown fields', () => {
    const result = chatCompletionsBodySchema.safeParse({
      ...validBase,
      some_unknown_field: 'extra',
      custom_metadata: { foo: 'bar' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).some_unknown_field).toBe('extra');
      expect((result.data as Record<string, unknown>).custom_metadata).toEqual({ foo: 'bar' });
    }
  });

  test('preserves tools field', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ];
    const result = chatCompletionsBodySchema.safeParse({ ...validBase, tools });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).tools).toEqual(tools);
    }
  });

  test('preserves tool_choice as string', () => {
    const result = chatCompletionsBodySchema.safeParse({ ...validBase, tool_choice: 'auto' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).tool_choice).toBe('auto');
    }
  });

  test('preserves tool_choice as object', () => {
    const toolChoice = { type: 'function', function: { name: 'get_weather' } };
    const result = chatCompletionsBodySchema.safeParse({ ...validBase, tool_choice: toolChoice });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).tool_choice).toEqual(toolChoice);
    }
  });

  test('preserves response_format', () => {
    const responseFormat = { type: 'json_object' };
    const result = chatCompletionsBodySchema.safeParse({ ...validBase, response_format: responseFormat });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).response_format).toEqual(responseFormat);
    }
  });

  test('preserves stream_options', () => {
    const streamOptions = { include_usage: true };
    const result = chatCompletionsBodySchema.safeParse({ ...validBase, stream_options: streamOptions });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).stream_options).toEqual(streamOptions);
    }
  });

  test('preserves all passthrough fields together', () => {
    const body = {
      ...validBase,
      tools: [{ type: 'function', function: { name: 'test' } }],
      tool_choice: 'auto',
      response_format: { type: 'json_object' },
      stream_options: { include_usage: true },
      custom_field: 'preserved',
    };
    const result = chatCompletionsBodySchema.safeParse(body);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.tools).toBeDefined();
      expect(data.tool_choice).toBe('auto');
      expect(data.response_format).toEqual({ type: 'json_object' });
      expect(data.stream_options).toEqual({ include_usage: true });
      expect(data.custom_field).toBe('preserved');
    }
  });
});