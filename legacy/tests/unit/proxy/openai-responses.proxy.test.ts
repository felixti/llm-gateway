import { describe, expect, test } from "bun:test";
import {
  transformChatCompletionsToResponse,
  createResponsesStreamTransformer,
  transformResponsesToChatCompletions,
} from "../../../src/proxy/openai-responses.proxy";

describe("transformChatCompletionsToResponse", () => {
  test("converts single choice", () => {
    const chatBody = {
      id: "chatcmp-123",
      created: 1700000000,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const result = transformChatCompletionsToResponse(chatBody) as Record<string, any>;

    expect(result.object).toBe("response");
    expect(result.id).toBe("chatcmp-123");
    expect(result.created_at).toBe(1700000000);
    expect(result.model).toBe("gpt-test");
    expect((result as Record<string, any>).output).toHaveLength(1);
    expect(result.output[0].type).toBe("message");
    expect(result.output[0].content).toEqual([
      { type: "output_text", text: "Hello" },
    ]);
    expect(result.usage).toEqual(chatBody.usage);
  });

  test("handles multiple choices", () => {
    const chatBody = {
      id: "chatcmp-456",
      created: 1700000001,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "A" },
          finish_reason: "stop",
        },
        {
          index: 1,
          message: { role: "assistant", content: "B" },
          finish_reason: "stop",
        },
      ],
    };

    const result = transformChatCompletionsToResponse(chatBody) as Record<string, any>;

    expect((result.output as unknown[])).toHaveLength(2);
    expect(result.output[0].id).toBe("chatcmp-456-0");
    expect(result.output[1].id).toBe("chatcmp-456-1");
  });

  test("defaults missing fields", () => {
    const result = transformChatCompletionsToResponse({});

    expect(result.id).toBe("");
    expect(result.object).toBe("response");
    expect(result.output).toEqual([]);
    expect(result.model).toBe("");
  });

  test("maps assistant tool calls to Responses function_call output items", () => {
    const result = transformChatCompletionsToResponse({
      id: "chatcmp-tools",
      created: 1700000004,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "file_search",
                  arguments: "{\"query\":\"quota\"}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) as Record<string, any>;

    expect(result.output).toEqual([
      {
        type: "function_call",
        id: "call_123",
        call_id: "call_123",
        name: "file_search",
        arguments: "{\"query\":\"quota\"}",
        status: "completed",
      },
    ]);
  });
});

describe("transformResponsesToChatCompletions", () => {
  test("preserves modern request fields and maps reasoning effort", () => {
    const result = transformResponsesToChatCompletions({
      model: "gpt-5.3-codex",
      input: "Plan the change",
      reasoning: { effort: "high" },
      tool_choice: "auto",
      response_format: { type: "json_object" },
      modalities: ["text"],
      max_completion_tokens: 256,
    });

    expect(result.messages).toEqual([{ role: "user", content: "Plan the change" }]);
    expect(result.reasoning_effort).toBe("high");
    expect(result.tool_choice).toBe("auto");
    expect(result.response_format).toEqual({ type: "json_object" });
    expect(result.modalities).toEqual(["text"]);
    expect(result.max_completion_tokens).toBe(256);
  });

  test("normalizes Responses tools to modern Chat Completions tools", () => {
    const result = transformResponsesToChatCompletions({
      model: "gpt-5.3-codex",
      input: "Read the file",
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        { type: "file_search" },
      ],
    });

    expect(result.functions).toBeUndefined();
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "file_search",
          description: "Built-in Responses API tool: file_search",
          parameters: { type: "object", properties: {}, additionalProperties: true },
        },
      },
    ]);
  });

  test("maps rich Responses input items to Chat Completions messages", () => {
    const result = transformResponsesToChatCompletions({
      model: "gpt-5.3-codex",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Follow repo rules" }],
        },
        {
          type: "function_call_output",
          call_id: "call_123",
          output: "file contents",
        },
      ],
    });

    expect(result.messages).toEqual([
      { role: "system", content: "Follow repo rules" },
      { role: "tool", tool_call_id: "call_123", content: "file contents" },
    ]);
  });
});

describe("createResponsesStreamTransformer", () => {
  function makeController(chunks: string[]): TransformStreamDefaultController {
    return {
      enqueue: (chunk: Uint8Array) => {
        chunks.push(new TextDecoder().decode(chunk));
      },
      terminate: () => {},
    } as unknown as TransformStreamDefaultController;
  }

  test("emits response.created on first chunk", () => {
    const transformer = createResponsesStreamTransformer();
    const chunks: string[] = [];
    const controller = makeController(chunks);

    const event = {
      id: "chatcmp-789",
      created: 1700000002,
      model: "gpt-test",
      choices: [{ index: 0, delta: { content: "H" } }],
    };

    transformer.transform(
      new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
      controller
    );

    expect(chunks.length).toBe(1);
    const text = chunks[0];
    expect(text).toContain("response.created");
    expect(text).toContain('"created_at":1700000002');
    expect(text).toContain("response.output_item.added");
    expect(text).toContain("response.content_part.added");
  });

  test("accumulates delta content across chunks", () => {
    const transformer = createResponsesStreamTransformer();
    const chunks: string[] = [];
    const controller = makeController(chunks);
    const encoder = new TextEncoder();

    const event1 = {
      id: "chatcmp-999",
      created: 1700000003,
      model: "gpt-test",
      choices: [{ index: 0, delta: { content: "Hello " } }],
    };
    const event2 = {
      id: "chatcmp-999",
      choices: [{ index: 0, delta: { content: "world" } }],
    };
    const event3 = {
      id: "chatcmp-999",
      choices: [{ index: 0, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };

    transformer.transform(encoder.encode(`data: ${JSON.stringify(event1)}\n\n`), controller);
    transformer.transform(encoder.encode(`data: ${JSON.stringify(event2)}\n\n`), controller);
    chunks.length = 0;
    transformer.transform(encoder.encode(`data: ${JSON.stringify(event3)}\n\n`), controller);

    expect(chunks.length).toBe(1);
    const text = chunks[0];
    expect(text).toContain("response.content_part.done");
    expect(text).toContain("response.output_item.done");
    expect(text).toContain('"text":"Hello world"');
    expect(text).toContain("response.done");
    expect(text).toContain('"total_tokens":5');
  });

  test("handles multi-choice accumulation", () => {
    const transformer = createResponsesStreamTransformer();
    const chunks: string[] = [];
    const controller = makeController(chunks);
    const encoder = new TextEncoder();

    const event1 = {
      id: "chatcmp-multi",
      choices: [
        { index: 0, delta: { content: "A" } },
      ],
    };
    const event2 = {
      id: "chatcmp-multi",
      choices: [
        { index: 0, delta: { content: "lpha" } },
      ],
    };
    const event3 = {
      id: "chatcmp-multi",
      choices: [
        { index: 0, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };

    transformer.transform(encoder.encode(`data: ${JSON.stringify(event1)}\n\n`), controller);
    transformer.transform(encoder.encode(`data: ${JSON.stringify(event2)}\n\n`), controller);
    chunks.length = 0;
    transformer.transform(encoder.encode(`data: ${JSON.stringify(event3)}\n\n`), controller);

    const text = chunks[0];
    expect(text).toContain('"text":"Alpha"');
    expect(text).toContain("chatcmp-multi-0");
  });

  test("preserves unrecognized lines", () => {
    const transformer = createResponsesStreamTransformer();
    const controller = {
      enqueue: (chunk: Uint8Array) => {
        const text = new TextDecoder().decode(chunk);
        expect(text).toContain("foo: bar");
      },
      terminate: () => {},
    } as unknown as TransformStreamDefaultController;

    transformer.transform(new TextEncoder().encode("foo: bar\n"), controller);
    expect.assertions(1);
  });

  test("emits Responses function_call items from streaming tool call deltas", () => {
    const transformer = createResponsesStreamTransformer();
    const chunks: string[] = [];
    const controller = makeController(chunks);
    const encoder = new TextEncoder();

    const event1 = {
      id: "chatcmp-tools",
      created: 1700000005,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_123",
                type: "function",
                function: { name: "shell_exec", arguments: "{\"cmd\":" },
              },
            ],
          },
        },
      ],
    };
    const event2 = {
      id: "chatcmp-tools",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: "\"pwd\"}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };

    transformer.transform(encoder.encode(`data: ${JSON.stringify(event1)}\n\n`), controller);
    transformer.transform(encoder.encode(`data: ${JSON.stringify(event2)}\n\n`), controller);

    const text = chunks.join("");
    expect(text).toContain("response.output_item.added");
    expect(text).toContain("response.output_item.done");
    expect(text).toContain('"type":"function_call"');
    expect(text).toContain('"name":"shell_exec"');
    expect(text).toContain('"arguments":"{\\"cmd\\":\\"pwd\\"}"');
  });
});
