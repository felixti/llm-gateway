import { describe, it, expect, beforeEach } from "bun:test";
import {
  extractOpenAIUsage,
  extractAnthropicUsage,
  parseAnthropicEvents,
  createOpenAIStreamTransformer,
  createOpenAIUsageObserver,
  createAnthropicStreamTransformer,
  handleStreamAbort,
  type OpenAIStreamChunk,
  type AnthropicStreamEvent,
  isAnthropicStreamEvent,
  isOpenAIStreamChunk,
} from "../../../src/utils/streaming";

describe("Streaming Utilities", () => {
  describe("SSE event validation", () => {
    it("rejects OpenAI chunks with malformed usage token fields", () => {
      expect(
        isOpenAIStreamChunk({
          id: "chatcmpl-123",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-5.4",
          choices: [],
          usage: { prompt_tokens: "10", completion_tokens: 5, total_tokens: 15 },
        })
      ).toBe(false);
    });

    it("rejects Anthropic events with malformed usage token fields", () => {
      expect(
        isAnthropicStreamEvent({
          type: "message_delta",
          usage: { input_tokens: 10, output_tokens: "5" },
        })
      ).toBe(false);
    });
  });

  describe("extractOpenAIUsage", () => {
    it("should extract usage from final OpenAI chunk", () => {
      const text = `data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677858242,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677858242,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}

data: [DONE]`;

      const usage = extractOpenAIUsage(text);

      expect(usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        thinking_tokens: undefined,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: undefined,
      });
    });

    it("should return null when no usage in text", () => {
      const text = `data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]`;

      const usage = extractOpenAIUsage(text);
      expect(usage).toBeNull();
    });

    it("should find usage in reversed order (last occurrence)", () => {
      const text = `data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}`;

      const usage = extractOpenAIUsage(text);
      expect(usage).toBeNull(); // No usage field present
    });

    it("should handle malformed JSON gracefully", () => {
      const text = `data: not valid json

data: {"id":"chatcmpl-123","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}

data: [DONE]`;

      const usage = extractOpenAIUsage(text);
      expect(usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        thinking_tokens: undefined,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: undefined,
      });
    });

    it("should return null for empty text", () => {
      const usage = extractOpenAIUsage("");
      expect(usage).toBeNull();
    });
  });

  describe("extractAnthropicUsage", () => {
    it("should extract usage from message_delta event", () => {
      const text = `data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[]}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text","text":"Hello"}}

data: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":5,"thinking_tokens":3}}

data: {"type":"message_stop"}`;

      const usage = extractAnthropicUsage(text);

      expect(usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        thinking_tokens: 3,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: undefined,
      });
    });

    it("should return null when no message_delta event", () => {
      const text = `data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[]}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text","text":"Hello"}}

data: {"type":"message_stop"}`;

      const usage = extractAnthropicUsage(text);
      expect(usage).toBeNull();
    });

    it("should handle message_delta without thinking_tokens", () => {
      const text = `data: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":5}}`;

      const usage = extractAnthropicUsage(text);

      expect(usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        thinking_tokens: undefined,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: undefined,
      });
    });

    it("should return null for empty text", () => {
      const usage = extractAnthropicUsage("");
      expect(usage).toBeNull();
    });
  });

  describe("parseAnthropicEvents", () => {
    it("should parse multiple SSE events", () => {
      const text = `data: {"type":"message_start","message":{"id":"msg_123"}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text","text":"Hello"}}

data: {"type":"message_stop"}`;

      const events = parseAnthropicEvents(text);

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe("message_start");
      expect(events[1].type).toBe("content_block_start");
      expect(events[2].type).toBe("content_block_delta");
      expect(events[3].type).toBe("message_stop");
    });

    it("should handle empty lines between events", () => {
      const text = `data: {"type":"message_start"}

data: {"type":"message_stop"}`;

      const events = parseAnthropicEvents(text);
      expect(events).toHaveLength(2);
    });

    it("should skip malformed JSON", () => {
      const text = `data: {"type":"message_start"}

data: not json

data: {"type":"message_stop"}`;

      const events = parseAnthropicEvents(text);
      expect(events).toHaveLength(2);
    });

    it("should return empty array for empty text", () => {
      const events = parseAnthropicEvents("");
      expect(events).toHaveLength(0);
    });

    it("should skip non-data lines", () => {
      const text = `event: message
data: {"type":"message_start"}

data: {"type":"message_stop"}`;

      const events = parseAnthropicEvents(text);
      expect(events).toHaveLength(2); // Both data: lines are valid
    });
  });

  describe("createOpenAIStreamTransformer", () => {
    it("should pass through regular chunks", async () => {
      const transformer = createOpenAIStreamTransformer();
      const chunks: Uint8Array[] = [];

      const mockController = {
        enqueue: (chunk: Uint8Array) => chunks.push(chunk),
        terminate: () => {},
      };

      const text = `data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n`;
      const chunk = new TextEncoder().encode(text);

      // @ts-ignore - testing transform directly
      transformer.transform(chunk, mockController);

      expect(chunks).toHaveLength(1);
    });

    it("should pass through a multi-event chunk exactly once", async () => {
      const transformer = createOpenAIStreamTransformer();
      const chunks: Uint8Array[] = [];

      const mockController = {
        enqueue: (chunk: Uint8Array) => chunks.push(chunk),
        terminate: () => {},
      };

      const text = [
        'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
        "",
      ].join("\n");
      const chunk = new TextEncoder().encode(text);

      // @ts-ignore - testing transform directly
      transformer.transform(chunk, mockController);

      expect(chunks).toHaveLength(1);
      expect(new TextDecoder().decode(chunks[0])).toBe(text);
    });

    it("should handle [DONE] chunk", async () => {
      const transformer = createOpenAIStreamTransformer();
      const chunks: Uint8Array[] = [];

      const mockController = {
        enqueue: (chunk: Uint8Array) => chunks.push(chunk),
        terminate: () => {},
      };

      const doneChunk = new TextEncoder().encode("data: [DONE]\n\n");

      // @ts-ignore - testing transform directly
      transformer.transform(doneChunk, mockController);

      expect(chunks).toHaveLength(1);
      expect(new TextDecoder().decode(chunks[0])).toBe("data: [DONE]\n\n");
    });
  });

  describe("createOpenAIUsageObserver", () => {
    it("extracts usage incrementally across split SSE frames", () => {
      const observed: unknown[] = [];
      const observer = createOpenAIUsageObserver((usage) => observed.push(usage));
      const encoder = new TextEncoder();

      observer.observe(
        encoder.encode(
          'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n'
        )
      );
      observer.observe(
        encoder.encode(
          'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
        )
      );
      observer.observe(
        encoder.encode('"usage":{"prompt_tokens":13,"completion_tokens":8,"total_tokens":21}}\n\n')
      );
      observer.observe(encoder.encode("data: [DONE]\n\n"));

      expect(observed).toEqual([
        {
          prompt_tokens: 13,
          completion_tokens: 8,
          thinking_tokens: undefined,
          cache_creation_input_tokens: undefined,
          cache_read_input_tokens: undefined,
        },
      ]);
    });

    it("does not emit usage more than once", () => {
      const observed: unknown[] = [];
      const observer = createOpenAIUsageObserver((usage) => observed.push(usage));
      const encoder = new TextEncoder();
      const event =
        'data: {"id":"chatcmpl-123","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n';

      observer.observe(encoder.encode(event));
      observer.observe(encoder.encode(event));

      expect(observed).toHaveLength(1);
    });
  });

  describe("createAnthropicStreamTransformer", () => {
    it("should pass through all chunks (native passthrough)", async () => {
      const transformer = createAnthropicStreamTransformer();
      const chunks: Uint8Array[] = [];

      const mockController = {
        enqueue: (chunk: Uint8Array) => chunks.push(chunk),
        terminate: () => {},
      };

      const event1 = new TextEncoder().encode('data: {"type":"message_start"}\n\n');
      const event2 = new TextEncoder().encode('data: {"type":"content_block_delta"}\n\n');

      // @ts-ignore - testing transform directly
      transformer.transform(event1, mockController);
      // @ts-ignore - testing transform directly
      transformer.transform(event2, mockController);

      expect(chunks).toHaveLength(2);
    });
  });

  describe("handleStreamAbort", () => {
    it("releases the reservation when the request abort signal fires", async () => {
      const controller = new AbortController();
      const released: string[] = [];

      handleStreamAbort("res-abort-1", async () => {
        released.push("res-abort-1");
      }, controller.signal);

      controller.abort();
      await Promise.resolve();

      expect(released).toEqual(["res-abort-1"]);
    });

    it("does not release twice when cleanup runs after an abort", async () => {
      const controller = new AbortController();
      const released: string[] = [];

      const cleanup = handleStreamAbort("res-abort-2", async () => {
        released.push("res-abort-2");
      }, controller.signal);

      controller.abort();
      cleanup();
      await Promise.resolve();

      expect(released).toEqual(["res-abort-2"]);
    });
  });
});
