/**
 * Pricing Service
 * Provides cost calculation using decimal.js with 6 decimal precision
 * Hot-reloads pricing configuration from pricing.json
 */

import { Decimal } from "decimal.js";
import pricingData from "../config/pricing.json";

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  thinking_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

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

/**
 * Normalize pricing data to use Decimal types
 */
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

// Initialize pricing cache with hot-reload support
let pricingCache: Map<string, ModelPricing> = normalizePricing(pricingData as PricingData);

/**
 * Reload pricing from JSON (for hot-reload support)
 */
export function reloadPricing(): void {
  // Re-read the pricing data
  // In Bun, we can use import() to re-fetch the JSON module
  import("../config/pricing.json").then((module) => {
    pricingCache = normalizePricing(module.default as PricingData);
  });
}

/**
 * Get pricing for a model by deployment pattern (case-insensitive)
 */
export function getPricingByPattern(deploymentPattern: string): ModelPricing | undefined {
  const pattern = deploymentPattern.toLowerCase();

  // Try exact match first
  if (pricingCache.has(pattern)) {
    return pricingCache.get(pattern);
  }

  // Try pattern matching
  for (const [, pricing] of pricingCache.entries()) {
    const deplPattern = pricing.deploymentPattern.toLowerCase();

    // Check for wildcard patterns
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
 * Uses decimal.js with 6 decimal precision
 */
export function calculateCost(usage: TokenUsage, model: string): Decimal {
  const pricing = getPricingByPattern(model);
  if (!pricing) {
    throw new Error(`No pricing found for model: ${model}`);
  }

  // Calculate each component
  const inputCost = new Decimal(usage.prompt_tokens)
    .div(1_000_000)
    .times(pricing.inputPerMillion);

  const outputCost = new Decimal(usage.completion_tokens)
    .div(1_000_000)
    .times(pricing.outputPerMillion);

  const thinkingCost = pricing.thinkingPerMillion && usage.thinking_tokens
    ? new Decimal(usage.thinking_tokens)
        .div(1_000_000)
        .times(pricing.thinkingPerMillion)
    : new Decimal(0);

  const cacheWriteCost = pricing.cacheWritePerMillion && usage.cache_creation_input_tokens
    ? new Decimal(usage.cache_creation_input_tokens)
        .div(1_000_000)
        .times(pricing.cacheWritePerMillion)
    : new Decimal(0);

  const cacheReadCost = pricing.cacheReadPerMillion && usage.cache_read_input_tokens
    ? new Decimal(usage.cache_read_input_tokens)
        .div(1_000_000)
        .times(pricing.cacheReadPerMillion)
    : new Decimal(0);

  // Sum all costs and return with 6 decimal precision
  return inputCost
    .plus(outputCost)
    .plus(thinkingCost)
    .plus(cacheWriteCost)
    .plus(cacheReadCost)
    .toDecimalPlaces(6);
}

/**
 * Calculate estimated cost for reservation (120% multiplier)
 */
export function calculateEstimatedCost(
  promptTokens: number,
  maxOutputTokens: number,
  model: string,
  thinkingTokens: number = 0
): Decimal {
  const usage: TokenUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: maxOutputTokens,
    thinking_tokens: thinkingTokens,
  };

  const baseCost = calculateCost(usage, model);

  // Apply 120% multiplier for reservation estimation
  const multiplier = new Decimal(1.2);
  return baseCost.times(multiplier).toDecimalPlaces(6);
}

/**
 * Get all available model pricing keys
 */
export function getAllPricingKeys(): string[] {
  return Array.from(pricingCache.keys());
}

/**
 * Validate pricing data structure
 */
export function validatePricingData(): boolean {
  return (pricingData as PricingData).version !== undefined &&
         (pricingData as PricingData).currency === "USD" &&
         Object.keys((pricingData as PricingData).models).length === 8;
}
