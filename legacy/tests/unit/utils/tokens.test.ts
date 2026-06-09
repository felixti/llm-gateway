import { describe, it, expect } from "bun:test";
import {
  estimateTokens,
  estimateMessagesTokens,
  estimateAnthropicTokens,
} from "../../../src/utils/tokens";

describe("Token Estimation", () => {
  describe("estimateTokens", () => {
    it("should return 0 for empty text", () => {
      expect(estimateTokens("", "gpt-5.4")).toBe(0);
    });

    it("should return 0 for null/undefined text", () => {
      expect(estimateTokens("", "gpt-5.4")).toBe(0);
    });

    it("should apply 1.1x multiplier for Claude models", () => {
      const text = "Hello world";
      const gptTokens = estimateTokens(text, "gpt-5.4");
      const claudeTokens = estimateTokens(text, "claude-opus-4-6");

      // Claude should have approximately 1.1x more tokens
      expect(claudeTokens).toBeGreaterThanOrEqual(gptTokens);
    });

    it("should apply 20% buffer for thinking-enabled requests", () => {
      const text = "Hello world";
      const normalTokens = estimateTokens(text, "claude-opus-4-6", { thinkingEnabled: false });
      const thinkingTokens = estimateTokens(text, "claude-opus-4-6", { thinkingEnabled: true });

      // Thinking should add 20% buffer
      expect(thinkingTokens).toBeGreaterThan(normalTokens);
      expect(thinkingTokens).toBeCloseTo(normalTokens * 1.2, 0);
    });

    it("should not apply thinking buffer for non-Claude models", () => {
      const text = "Hello world";
      const normalTokens = estimateTokens(text, "gpt-5.4", { thinkingEnabled: false });
      const thinkingTokens = estimateTokens(text, "gpt-5.4", { thinkingEnabled: true });

      // Thinking buffer only applies to Claude models
      expect(thinkingTokens).toBe(normalTokens);
    });

    it("should handle short text", () => {
      const tokens = estimateTokens("hi", "gpt-5.4");
      expect(tokens).toBeGreaterThan(0);
    });

    it("should handle long text", () => {
      const longText = "a".repeat(1000);
      const tokens = estimateTokens(longText, "gpt-5.4");
      expect(tokens).toBeGreaterThan(0);
    });

    it("should be case-insensitive for model names", () => {
      const text = "Hello world";
      const lowerTokens = estimateTokens(text, "claude-opus-4-6");
      const upperTokens = estimateTokens(text, "CLAUDE-OPUS-4-6");

      expect(lowerTokens).toBe(upperTokens);
    });
  });

  describe("estimateMessagesTokens", () => {
    it("should return 0 for empty messages array", () => {
      expect(estimateMessagesTokens([], "gpt-5.4")).toBe(0);
    });

    it("should estimate tokens for a single message", () => {
      const messages = [{ role: "user", content: "Hello" }];
      const tokens = estimateMessagesTokens(messages, "gpt-5.4");
      expect(tokens).toBeGreaterThan(0);
    });

    it("should estimate tokens for multiple messages", () => {
      const messages = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];
      const tokens = estimateMessagesTokens(messages, "gpt-5.4");
      expect(tokens).toBeGreaterThan(0);
    });

    it("should handle messages with missing content", () => {
      const messages = [
        { role: "user" },
        { role: "assistant", content: "Hello" },
      ];
      const tokens = estimateMessagesTokens(messages, "gpt-5.4");
      expect(tokens).toBeGreaterThan(0);
    });

    it("should add overhead for message structure", () => {
      const singleMessage = [{ role: "user", content: "Hello" }];
      const doubleMessage = [
        { role: "user", content: "Hello" },
        { role: "user", content: "World" },
      ];

      const singleTokens = estimateMessagesTokens(singleMessage, "gpt-5.4");
      const doubleTokens = estimateMessagesTokens(doubleMessage, "gpt-5.4");

      // Double messages should have more tokens (content + structure overhead)
      expect(doubleTokens).toBeGreaterThan(singleTokens);
    });
  });

  describe("estimateAnthropicTokens", () => {
    it("should return 0 for empty messages array", () => {
      expect(estimateAnthropicTokens([], "claude-opus-4-6")).toBe(0);
    });

    it("should estimate tokens for a single message", () => {
      const messages = [{ role: "user", content: "Hello" }];
      const tokens = estimateAnthropicTokens(messages, "claude-opus-4-6");
      expect(tokens).toBeGreaterThan(0);
    });

    it("should handle thinkingEnabled flag", () => {
      const messages = [{ role: "user", content: "Hello" }];
      const normalTokens = estimateAnthropicTokens(messages, "claude-opus-4-6", false);
      const thinkingTokens = estimateAnthropicTokens(messages, "claude-opus-4-6", true);

      expect(thinkingTokens).toBeGreaterThan(normalTokens);
    });

    it("should handle content blocks (array content)", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
        },
      ];
      const tokens = estimateAnthropicTokens(messages, "claude-opus-4-6");
      expect(tokens).toBeGreaterThan(0);
    });

    it("should handle non-Claude models without thinking buffer", () => {
      const messages = [{ role: "user", content: "Hello" }];
      const tokens = estimateAnthropicTokens(messages, "gpt-5.4", true);

      // Non-Claude should not apply thinking buffer
      const tokensWithoutThinking = estimateAnthropicTokens(messages, "gpt-5.4", false);
      expect(tokens).toBe(tokensWithoutThinking);
    });
  });
});
