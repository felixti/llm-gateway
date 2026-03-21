import { describe, it, expect } from "bun:test";
import { Decimal } from "decimal.js";
import {
  calculateCost,
  calculateEstimatedCost,
  getPricingByPattern,
  getAllPricingKeys,
  type TokenUsage,
} from "../../../src/services/pricing.service";

describe("Pricing Service", () => {
  describe("calculateCost", () => {
    it("should calculate cost for GPT-5.4 correctly", () => {
      const usage: TokenUsage = {
        prompt_tokens: 1000,
        completion_tokens: 500,
      };
      const cost = calculateCost(usage, "gpt-5.4");
      // 1000 input @ $5/M = $0.005, 500 output @ $15/M = $0.0075
      expect(cost.toNumber()).toBeCloseTo(0.0125, 4);
    });

    it("should calculate cost for GPT-5.3-Codex correctly", () => {
      const usage: TokenUsage = {
        prompt_tokens: 1000,
        completion_tokens: 500,
      };
      const cost = calculateCost(usage, "gpt-5.3-codex");
      // 1000 input @ $4/M = $0.004, 500 output @ $12/M = $0.006
      expect(cost.toNumber()).toBeCloseTo(0.01, 4);
    });

    it("should calculate cost for Claude Opus with thinking tokens", () => {
      const usage: TokenUsage = {
        prompt_tokens: 1000,
        completion_tokens: 500,
        thinking_tokens: 200,
      };
      const cost = calculateCost(usage, "claude-opus-4-6");
      // 1000 input @ $15/M = $0.015
      // 500 output @ $75/M = $0.0375
      // 200 thinking @ $15/M = $0.003
      expect(cost.toNumber()).toBeCloseTo(0.0555, 4);
    });

    it("should calculate cost for Claude Sonnet with thinking tokens", () => {
      const usage: TokenUsage = {
        prompt_tokens: 1000,
        completion_tokens: 500,
        thinking_tokens: 100,
      };
      const cost = calculateCost(usage, "claude-sonnet-4-6");
      // 1000 input @ $3/M = $0.003
      // 500 output @ $15/M = $0.0075
      // 100 thinking @ $3/M = $0.0003
      expect(cost.toNumber()).toBeCloseTo(0.0108, 4);
    });

    it("should calculate cost for Claude with cache tokens", () => {
      const usage: TokenUsage = {
        prompt_tokens: 1000,
        completion_tokens: 500,
        thinking_tokens: 0,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 500,
      };
      const cost = calculateCost(usage, "claude-opus-4-6");
      // 1000 input @ $15/M = $0.015
      // 500 output @ $75/M = $0.0375
      // 100 cache_write @ $18.75/M = $0.001875
      // 500 cache_read @ $1.5/M = $0.00075
      expect(cost.toNumber()).toBeCloseTo(0.055125, 4);
    });

    it("should calculate cost for Kimi correctly", () => {
      const usage: TokenUsage = {
        prompt_tokens: 1000,
        completion_tokens: 500,
      };
      const cost = calculateCost(usage, "kimi-k2.5");
      // 1000 input @ $2.5/M = $0.0025, 500 output @ $10/M = $0.005
      expect(cost.toNumber()).toBeCloseTo(0.0075, 4);
    });

    it("should calculate cost for GLM correctly", () => {
      const usage: TokenUsage = {
        prompt_tokens: 1000,
        completion_tokens: 500,
      };
      const cost = calculateCost(usage, "glm-5");
      // 1000 input @ $2/M = $0.002, 500 output @ $8/M = $0.004
      expect(cost.toNumber()).toBeCloseTo(0.006, 4);
    });

    it("should calculate cost for MiniMax correctly", () => {
      const usage: TokenUsage = {
        prompt_tokens: 1000,
        completion_tokens: 500,
      };
      const cost = calculateCost(usage, "minimax-m2.5");
      // 1000 input @ $1.8/M = $0.0018, 500 output @ $7.2/M = $0.0036
      expect(cost.toNumber()).toBeCloseTo(0.0054, 4);
    });

    it("should return zero cost when tokens are zero", () => {
      const usage: TokenUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
      };
      const cost = calculateCost(usage, "gpt-5.4");
      expect(cost.toNumber()).toBe(0);
    });

    it("should throw for unknown model", () => {
      const usage: TokenUsage = {
        prompt_tokens: 100,
        completion_tokens: 100,
      };
      expect(() => calculateCost(usage, "unknown-model")).toThrow();
    });

    it("should use 6 decimal precision", () => {
      const usage: TokenUsage = {
        prompt_tokens: 1,
        completion_tokens: 1,
      };
      const cost = calculateCost(usage, "gpt-5.4");
      // Should have at most 6 decimal places
      expect(cost.toFixed(6)).toBeDefined();
    });

    it("should handle missing optional tokens gracefully", () => {
      const usage: TokenUsage = {
        prompt_tokens: 1000,
        completion_tokens: 500,
        // No thinking_tokens, cache_creation_input_tokens, cache_read_input_tokens
      };
      const cost = calculateCost(usage, "claude-opus-4-6");
      // Should only count input and output
      // 1000 input @ $15/M = $0.015
      // 500 output @ $75/M = $0.0375
      expect(cost.toNumber()).toBeCloseTo(0.0525, 4);
    });
  });

  describe("calculateEstimatedCost", () => {
    it("should apply 120% multiplier for reservations", () => {
      const estimated = calculateEstimatedCost(1000, 500, "gpt-5.4");
      const baseCost = calculateCost(
        { prompt_tokens: 1000, completion_tokens: 500 },
        "gpt-5.4"
      );

      // Estimated should be 120% of base cost
      expect(estimated.toNumber()).toBeCloseTo(baseCost.toNumber() * 1.2, 4);
    });

    it("should include thinking tokens in estimate", () => {
      const withThinking = calculateEstimatedCost(1000, 500, "claude-opus-4-6", 200);
      const withoutThinking = calculateEstimatedCost(1000, 500, "claude-opus-4-6", 0);

      expect(withThinking.toNumber()).toBeGreaterThan(withoutThinking.toNumber());
    });

    it("should return Decimal type", () => {
      const cost = calculateEstimatedCost(1000, 500, "gpt-5.4");
      expect(cost instanceof Decimal).toBe(true);
    });
  });

  describe("getPricingByPattern", () => {
    it("should find pricing for gpt-5.4", () => {
      const pricing = getPricingByPattern("gpt-5.4");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerMillion.toNumber()).toBe(5.0);
    });

    it("should find pricing for claude-opus-4-6", () => {
      const pricing = getPricingByPattern("claude-opus-4-6");
      expect(pricing).toBeDefined();
      expect(pricing?.thinkingPerMillion?.toNumber()).toBe(15.0);
    });

    it("should be case-insensitive", () => {
      expect(getPricingByPattern("GPT-5.4")?.inputPerMillion.toNumber()).toBe(5.0);
      expect(getPricingByPattern("Claude-Opus-4-6")?.inputPerMillion.toNumber()).toBe(15.0);
    });

    it("should return undefined for unknown model", () => {
      expect(getPricingByPattern("unknown-model")).toBeUndefined();
    });
  });

  describe("getAllPricingKeys", () => {
    it("should return all 8 model pricing keys", () => {
      const keys = getAllPricingKeys();
      expect(keys.length).toBe(8);
    });
  });
});
