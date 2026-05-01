import { describe, it, expect } from "bun:test";
import { Decimal } from "decimal.js";
import {
  getPricingByPattern,
  calculateCost,
  getAllPricingKeys,
  validatePricingData,
} from "../../../src/config/pricing";

describe("Pricing Service", () => {
  describe("getPricingByPattern", () => {
    it("should find pricing for gpt-5-mini", () => {
      const pricing = getPricingByPattern("gpt-5-mini");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerMillion.toNumber()).toBe(0.25);
      expect(pricing?.outputPerMillion.toNumber()).toBe(2.0);
    });

    it("should find pricing for gpt-5.4", () => {
      const pricing = getPricingByPattern("gpt-5.4");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerMillion.toNumber()).toBe(5.0);
      expect(pricing?.outputPerMillion.toNumber()).toBe(15.0);
    });

    it("should find pricing for gpt-5.3-codex", () => {
      const pricing = getPricingByPattern("gpt-5.3-codex");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerMillion.toNumber()).toBe(4.0);
      expect(pricing?.outputPerMillion.toNumber()).toBe(12.0);
    });

    it("should find pricing for claude-opus-4-6 with thinking tokens", () => {
      const pricing = getPricingByPattern("claude-opus-4-6");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerMillion.toNumber()).toBe(15.0);
      expect(pricing?.outputPerMillion.toNumber()).toBe(75.0);
      expect(pricing?.thinkingPerMillion?.toNumber()).toBe(15.0);
      expect(pricing?.cacheWritePerMillion?.toNumber()).toBe(18.75);
      expect(pricing?.cacheReadPerMillion?.toNumber()).toBe(1.5);
    });

    it("should find pricing for claude-sonnet-4-6 with thinking tokens", () => {
      const pricing = getPricingByPattern("claude-sonnet-4-6");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerMillion.toNumber()).toBe(3.0);
      expect(pricing?.outputPerMillion.toNumber()).toBe(15.0);
      expect(pricing?.thinkingPerMillion?.toNumber()).toBe(3.0);
    });

    it("should find pricing for claude-haiku-4-5 without thinking tokens", () => {
      const pricing = getPricingByPattern("claude-haiku-4-5");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerMillion.toNumber()).toBe(0.25);
      expect(pricing?.outputPerMillion.toNumber()).toBe(1.25);
      expect(pricing?.thinkingPerMillion).toBeUndefined();
    });

    it("should find pricing for kimi-k2.5", () => {
      const pricing = getPricingByPattern("kimi-k2.5");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerMillion.toNumber()).toBe(2.5);
      expect(pricing?.outputPerMillion.toNumber()).toBe(10.0);
    });

    it("should find pricing for glm-5", () => {
      const pricing = getPricingByPattern("glm-5");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerMillion.toNumber()).toBe(2.0);
      expect(pricing?.outputPerMillion.toNumber()).toBe(8.0);
    });

    it("should find pricing for minimax-m2.5", () => {
      const pricing = getPricingByPattern("minimax-m2.5");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerMillion.toNumber()).toBe(1.8);
      expect(pricing?.outputPerMillion.toNumber()).toBe(7.2);
    });

    it("should be case-insensitive", () => {
      expect(getPricingByPattern("GPT-5-MINI")?.inputPerMillion.toNumber()).toBe(0.25);
      expect(getPricingByPattern("GPT-5.4")?.inputPerMillion.toNumber()).toBe(5.0);
      expect(getPricingByPattern("Claude-Opus-4-6")?.inputPerMillion.toNumber()).toBe(15.0);
      expect(getPricingByPattern("KIMI-K2.5")?.inputPerMillion.toNumber()).toBe(2.5);
    });

    it("should return undefined for unknown model", () => {
      expect(getPricingByPattern("unknown-model")).toBeUndefined();
    });
  });

  describe("calculateCost", () => {
    it("should calculate cost for GPT-5.4 correctly", () => {
      const cost = calculateCost("gpt-5.4", 1000, 500);
      // 1000 input @ $5/M = $0.005, 500 output @ $15/M = $0.0075
      expect(cost.toNumber()).toBeCloseTo(0.0125, 4);
    });

    it("should calculate cost for GPT-5 Mini correctly", () => {
      const cost = calculateCost("gpt-5-mini", 1000, 500);
      // 1000 input @ $0.25/M = $0.00025, 500 output @ $2/M = $0.001
      expect(cost.toNumber()).toBeCloseTo(0.00125, 6);
    });

    it("should calculate cost for GPT-5.3-Codex correctly", () => {
      const cost = calculateCost("gpt-5.3-codex", 1000, 500);
      // 1000 input @ $4/M = $0.004, 500 output @ $12/M = $0.006
      expect(cost.toNumber()).toBeCloseTo(0.01, 4);
    });

    it("should calculate cost for Claude Opus with thinking tokens", () => {
      const cost = calculateCost("claude-opus-4-6", 1000, 500, 200);
      // 1000 input @ $15/M = $0.015
      // 500 output @ $75/M = $0.0375
      // 200 thinking @ $15/M = $0.003
      expect(cost.toNumber()).toBeCloseTo(0.0555, 4);
    });

    it("should calculate cost for Claude Sonnet with thinking tokens", () => {
      const cost = calculateCost("claude-sonnet-4-6", 1000, 500, 100);
      // 1000 input @ $3/M = $0.003
      // 500 output @ $15/M = $0.0075
      // 100 thinking @ $3/M = $0.0003
      expect(cost.toNumber()).toBeCloseTo(0.0108, 4);
    });

    it("should calculate cost for Claude with cache tokens", () => {
      const cost = calculateCost("claude-opus-4-6", 1000, 500, 0, 100, 500);
      // 1000 input @ $15/M = $0.015
      // 500 output @ $75/M = $0.0375
      // 100 cache_write @ $18.75/M = $0.001875
      // 500 cache_read @ $1.5/M = $0.00075
      expect(cost.toNumber()).toBeCloseTo(0.055125, 4);
    });

    it("should calculate cost for Kimi correctly", () => {
      const cost = calculateCost("kimi-k2.5", 1000, 500);
      // 1000 input @ $2.5/M = $0.0025, 500 output @ $10/M = $0.005
      expect(cost.toNumber()).toBeCloseTo(0.0075, 4);
    });

    it("should calculate cost for GLM correctly", () => {
      const cost = calculateCost("glm-5", 1000, 500);
      // 1000 input @ $2/M = $0.002, 500 output @ $8/M = $0.004
      expect(cost.toNumber()).toBeCloseTo(0.006, 4);
    });

    it("should calculate cost for MiniMax correctly", () => {
      const cost = calculateCost("minimax-m2.5", 1000, 500);
      // 1000 input @ $1.8/M = $0.0018, 500 output @ $7.2/M = $0.0036
      expect(cost.toNumber()).toBeCloseTo(0.0054, 4);
    });

    it("should return zero cost when tokens are zero", () => {
      const cost = calculateCost("gpt-5.4", 0, 0);
      expect(cost.toNumber()).toBe(0);
    });

    it("should throw for unknown model", () => {
      expect(() => calculateCost("unknown-model", 100, 100)).toThrow();
    });
  });

  describe("getAllPricingKeys", () => {
    it("should return all 9 model pricing keys", () => {
      const keys = getAllPricingKeys();
      expect(keys.length).toBe(9);
    });
  });

  describe("validatePricingData", () => {
    it("should validate correct pricing data", () => {
      expect(validatePricingData()).toBe(true);
    });
  });
});
