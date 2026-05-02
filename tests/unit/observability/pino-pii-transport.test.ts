import { describe, it, expect } from "bun:test";
import { PinoPIITransform, createPIISanitizeStream } from "../../../src/observability/pino-pii-transport";

function createCapturingStream(): { write: (data: string) => void; captured: string[] } {
  const captured: string[] = [];
  return {
    write(data: string) {
      captured.push(data);
    },
    captured,
  };
}

describe("PinoPIITransform", () => {
  describe("email sanitization", () => {
    it("should sanitize email addresses in log entries", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      const entry = JSON.stringify({ level: 30, msg: "user test@example.com logged in", userId: "u1" });
      transform.write(entry);
      const output = JSON.parse(captured[0]);
      expect(output.msg).toBe("user u***@***.com logged in");
    });

    it("should sanitize emails nested in objects", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      const entry = JSON.stringify({ level: 30, context: { user: { email: "admin@corp.io" } } });
      transform.write(entry);
      const output = JSON.parse(captured[0]);
      expect(output.context.user.email).toBe("u***@***.com");
    });
  });

  describe("PAT token sanitization", () => {
    it("should sanitize PAT tokens in log entries", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      const entry = JSON.stringify({
        level: 30,
        msg: "auth with lg_user123_header.payload.signature",
      });
      transform.write(entry);
      const output = JSON.parse(captured[0]);
      expect(output.msg).toBe("auth with lg_***_***.***");
    });

    it("should sanitize PAT tokens in nested fields", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      const entry = JSON.stringify({
        level: 30,
        auth: { token: "lg_abc_xyz.def.ghi" },
      });
      transform.write(entry);
      const output = JSON.parse(captured[0]);
      expect(output.auth.token).toBe("lg_***_***.***");
    });
  });

  describe("API key sanitization", () => {
    it("should sanitize API keys in log entries", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      const entry = JSON.stringify({
        level: 30,
        msg: "using key sk-1234567890abcdefghijklmn",
      });
      transform.write(entry);
      const output = JSON.parse(captured[0]);
      expect(output.msg).toBe("using key sk-***");
    });
  });

  describe("multiple PII types", () => {
    it("should sanitize all PII types in a single entry", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      const entry = JSON.stringify({
        level: 40,
        msg: "user alice@evil.com used lg_x_y.z.w with sk-longapikey123456789012345",
        extra: "no-pii-here",
      });
      transform.write(entry);
      const output = JSON.parse(captured[0]);
      expect(output.msg).toBe("user u***@***.com used lg_***_***.*** with sk-***");
      expect(output.extra).toBe("no-pii-here");
    });
  });

  describe("non-PII data preservation", () => {
    it("should preserve legitimate structured data", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      const entry = JSON.stringify({
        level: 30,
        model: "gpt-4o",
        tokens: 1500,
        cost_usd: 0.03,
        protocol: "openai",
        trace_id: "abc-123-def",
      });
      transform.write(entry);
      const output = JSON.parse(captured[0]);
      expect(output.model).toBe("gpt-4o");
      expect(output.tokens).toBe(1500);
      expect(output.cost_usd).toBe(0.03);
      expect(output.protocol).toBe("openai");
      expect(output.trace_id).toBe("abc-123-def");
    });
  });

  describe("unparseable entries", () => {
    it("should fall back to string sanitization for unparseable JSON", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      transform.write("not-json {user@example.com} data");
      expect(captured[0]).toBe("not-json {u***@***.com} data");
    });

    it("should forward entries with no PII unchanged", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      const entry = JSON.stringify({ level: 30, msg: "healthy check ok" });
      transform.write(entry);
      expect(captured[0]).toBe(entry);
    });
  });

  describe("createPIISanitizeStream", () => {
    it("should create a PinoPIITransform instance", () => {
      const stream = createPIISanitizeStream();
      expect(stream).toBeInstanceOf(PinoPIITransform);
    });

    it("should accept a custom destination", () => {
      const { write } = createCapturingStream();
      const stream = createPIISanitizeStream({ write });
      expect(stream).toBeInstanceOf(PinoPIITransform);
    });
  });

  describe("integration with pino logger output", () => {
    it("should sanitize logger.info output through the transform", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      const logLine = JSON.stringify({
        level: 30,
        time: "2026-01-01T00:00:00.000Z",
        msg: "request completed",
        userId: "lg_user_abc.def.ghi",
        email: "leaked@secret.com",
      });
      transform.write(logLine);
      const output = JSON.parse(captured[0]);
      expect(output.userId).toBe("lg_***_***.***");
      expect(output.email).toBe("u***@***.com");
      expect(output.msg).toBe("request completed");
    });

    it("should handle arrays in log entries", () => {
      const { write, captured } = createCapturingStream();
      const transform = new PinoPIITransform({ write });
      const entry = JSON.stringify({
        level: 30,
        users: ["alice@co.org", "bob@co.org"],
      });
      transform.write(entry);
      const output = JSON.parse(captured[0]);
      expect(output.users).toEqual(["u***@***.com", "u***@***.com"]);
    });
  });
});