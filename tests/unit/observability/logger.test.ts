import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  sanitizePII,
  formatRequestLog,
  createLogger,
  logRequest,
  logError,
  logWarning,
  getRequestBodyLogMetadata,
} from "../../../src/observability/logger";

describe("Logger Service", () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    process.env.LOG_LEVEL = "info";
  });

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  describe("sanitizePII", () => {
    it("should redact email addresses", () => {
      const input = { email: "user@example.com", name: "John" };
      const result = sanitizePII(input) as Record<string, unknown>;
      expect(result.email).toBe("u***@***.com");
      expect(result.name).toBe("John");
    });

    it("should redact PAT tokens", () => {
      const input = {
        token: "lg_user123_header.payload.signature",
        name: "Test",
      };
      const result = sanitizePII(input) as Record<string, unknown>;
      expect(result.token).toBe("lg_***_***.***");
      expect(result.name).toBe("Test");
    });

    it("should redact API key prefixes", () => {
      const input = {
        apiKey: "sk-1234567890abcdefghijklmnop",
        name: "Test",
      };
      const result = sanitizePII(input) as Record<string, unknown>;
      expect(result.apiKey).toBe("sk-***");
      expect(result.name).toBe("Test");
    });

    it("should handle nested objects", () => {
      const input = {
        user: {
          email: "test@test.com",
          metadata: {
            token: "lg_user_abc.def.ghi",
          },
        },
      };
      const result = sanitizePII(input) as { user: { email: string; metadata: { token: string } } };
      expect(result.user.email).toBe("u***@***.com");
      expect(result.user.metadata.token).toBe("lg_***_***.***");
    });

    it("should handle arrays", () => {
      const input = [
        { email: "a@b.com" },
        { email: "c@d.com" },
      ];
      const result = sanitizePII(input) as Array<{ email: string }>;
      expect(result[0].email).toBe("u***@***.com");
      expect(result[1].email).toBe("u***@***.com");
    });

    it("should handle strings with multiple PII types", () => {
      const input =
        "Contact user@example.com with token lg_abc.def.ghi and key sk-1234567890";
      const result = sanitizePII(input);
      expect(result).toContain("u***@***.com");
      expect(result).toContain("lg_***_***.***");
      expect(result).toContain("sk-***");
    });

    it("should return primitive values unchanged", () => {
      expect(sanitizePII(42)).toBe(42);
      expect(sanitizePII(true)).toBe(true);
      expect(sanitizePII(null)).toBe(null);
    });

    it("should handle null object", () => {
      expect(sanitizePII(null)).toBe(null);
    });
  });

  describe("formatRequestLog", () => {
    it("should format complete request context", () => {
      const ctx = {
        traceId: "abc123",
        userId: "user1",
        model: "gpt-4o",
        tokens: 1000,
        cost: 0.05,
        duration: 150,
        status: 200,
        protocol: "openai",
      };
      const result = formatRequestLog(ctx);

      expect(result).toEqual({
        timestamp: expect.any(String),
        trace_id: "abc123",
        user_id: "user1",
        model: "gpt-4o",
        tokens: 1000,
        cost_usd: 0.05,
        duration_ms: 150,
        status: 200,
        protocol: "openai",
      });
    });

    it("should use default values for missing fields", () => {
      const ctx = {};
      const result = formatRequestLog(ctx);

      expect(result).toEqual({
        timestamp: expect.any(String),
        trace_id: "unknown",
        user_id: "unknown",
        model: "unknown",
        tokens: 0,
        cost_usd: 0,
        duration_ms: 0,
        status: 0,
        protocol: "unknown",
      });
    });

    it("should handle null traceId", () => {
      const ctx = { traceId: null };
      const result = formatRequestLog(ctx);
      expect(result).toMatchObject({ trace_id: "unknown" });
    });
  });

  describe("getRequestBodyLogMetadata", () => {
    it("summarizes request bodies without message content", () => {
      const metadata = getRequestBodyLogMetadata({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "secret prompt" }],
        tools: [{ type: "function", name: "search", parameters: { q: "secret" } }],
        stream: true,
        max_completion_tokens: 100,
      });

      expect(metadata).toMatchObject({
        model: "gpt-5.4",
        stream: true,
        messageCount: 1,
        toolCount: 1,
        maxCompletionTokens: 100,
      });
      expect(JSON.stringify(metadata)).not.toContain("secret prompt");
      expect(JSON.stringify(metadata)).not.toContain("parameters");
    });
  });

  describe("createLogger", () => {
    it("should create logger instance", () => {
      const logger = createLogger("test-service");
      expect(logger).toBeDefined();
      expect(logger.level).toBe("info");
    });

    it("should create logger without name", () => {
      const logger = createLogger();
      expect(logger).toBeDefined();
    });
  });

  describe("logRequest", () => {
    it("should log request with context", () => {
      const ctx = {
        traceId: "trace123",
        userId: "user1",
        model: "gpt-4o",
        tokens: 100,
        cost: 0.01,
        duration: 50,
        status: 200,
        protocol: "openai",
      };

      // Should not throw
      expect(() => logRequest(ctx, "Request completed")).not.toThrow();
    });

    it("should handle empty context", () => {
      const ctx = {};
      expect(() => logRequest(ctx, "Request completed")).not.toThrow();
    });
  });

  describe("logError", () => {
    it("should log error with context", () => {
      const ctx = {
        traceId: "trace123",
        userId: "user1",
        model: "gpt-4o",
        status: 500,
      };
      const error = new Error("Test error");

      expect(() => logError(ctx, error, "Request failed")).not.toThrow();
    });
  });

  describe("logWarning", () => {
    it("should log warning with context", () => {
      const ctx = {
        traceId: "trace123",
        userId: "user1",
        model: "gpt-4o",
      };

      expect(() => logWarning(ctx, "Rate limit approaching")).not.toThrow();
    });
  });
});
