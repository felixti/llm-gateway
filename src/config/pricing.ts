import { Decimal } from "decimal.js";
import pricingData from "./pricing.json";

export interface ModelPricing {
  deploymentPattern: string;
  inputPerMillion: Decimal;
  outputPerMillion: Decimal;
  thinkingPerMillion?: Decimal;
  cacheWritePerMillion?: Decimal;
  cacheReadPerMillion?: Decimal;
}

interface PricingData {
  version: string;
  currency: string;
  models: Record<string, {
    deployment_pattern: string;
    input_per_million: number;
    output_per_million: number;
    thinking_tokens_per_million?: number;
    cache_write_per_million?: number;
    cache_read_per_million?: number;
  }>;
}

// Normalize pricing data to use Decimal
function normalizePricing(data: PricingData): Map<string, ModelPricing> {
  const normalized = new Map<string, ModelPricing>();

  for (const [key, model] of Object.entries(data.models)) {
    normalized.set(key.toLowerCase(), {
      deploymentPattern: model.deployment_pattern,
      inputPerMillion: new Decimal(model.input_per_million),
      outputPerMillion: new Decimal(model.output_per_million),
      thinkingPerMillion: model.thinking_tokens_per_million
        ? new Decimal(model.thinking_tokens_per_million)
        : undefined,
      cacheWritePerMillion: model.cache_write_per_million
        ? new Decimal(model.cache_write_per_million)
        : undefined,
      cacheReadPerMillion: model.cache_read_per_million
        ? new Decimal(model.cache_read_per_million)
        : undefined,
    });
  }

  return normalized;
}

const PRICING_CACHE = normalizePricing(pricingData as PricingData);

/**
 * Get pricing for a model by deployment pattern (case-insensitive)
 * Uses pattern matching to find the best fit
 */
export function getPricingByPattern(deploymentPattern: string): ModelPricing | undefined {
  const pattern = deploymentPattern.toLowerCase();

  // Try exact match first
  if (PRICING_CACHE.has(pattern)) {
    return PRICING_CACHE.get(pattern);
  }

  // Try pattern matching (prefix/suffix)
  for (const [, pricing] of PRICING_CACHE.entries()) {
    const deplPattern = pricing.deploymentPattern.toLowerCase();

    // Check for wildcard patterns like "gpt-5.4*" or "*kimi*"
    if (deplPattern.endsWith("*") && pattern.startsWith(deplPattern.slice(0, -1))) {
      return pricing;
    }
    if (deplPattern.startsWith("*") && pattern.endsWith(deplPattern.slice(1))) {
      return pricing;
    }
    if (pattern.includes(deplPattern.replace(/\*/g, ""))) {
      return pricing;
    }
  }

  return undefined;
}

/**
 * Calculate cost for a given model and token usage
 */
export function calculateCost(
  modelAlias: string,
  inputTokens: number,
  outputTokens: number,
  thinkingTokens: number = 0,
  cacheWriteTokens: number = 0,
  cacheReadTokens: number = 0
): Decimal {
  const pricing = getPricingByPattern(modelAlias);
  if (!pricing) {
    throw new Error(`No pricing found for model: ${modelAlias}`);
  }

  const inputCost = new Decimal(inputTokens).div(1_000_000).times(pricing.inputPerMillion);
  const outputCost = new Decimal(outputTokens).div(1_000_000).times(pricing.outputPerMillion);
  const thinkingCost = pricing.thinkingPerMillion
    ? new Decimal(thinkingTokens).div(1_000_000).times(pricing.thinkingPerMillion)
    : new Decimal(0);
  const cacheWriteCost = pricing.cacheWritePerMillion
    ? new Decimal(cacheWriteTokens).div(1_000_000).times(pricing.cacheWritePerMillion)
    : new Decimal(0);
  const cacheReadCost = pricing.cacheReadPerMillion
    ? new Decimal(cacheReadTokens).div(1_000_000).times(pricing.cacheReadPerMillion)
    : new Decimal(0);

  return inputCost.plus(outputCost).plus(thinkingCost).plus(cacheWriteCost).plus(cacheReadCost);
}

/**
 * Get all available model pricing keys
 */
export function getAllPricingKeys(): string[] {
  return Array.from(PRICING_CACHE.keys());
}

/**
 * Validate pricing data structure
 */
export function validatePricingData(): boolean {
  return pricingData.version !== undefined &&
         pricingData.currency === "USD" &&
         Object.keys(pricingData.models).length === 8;
}

// Export raw pricing data for reference
export { pricingData };
