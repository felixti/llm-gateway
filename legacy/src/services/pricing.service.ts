/**
 * Pricing Service
 * Provides cost calculation using decimal.js with 6 decimal precision
 * Hot-reloads pricing configuration from pricing.json
 */

import { type FSWatcher, watch } from 'node:fs';
import { env } from '@/config/env';
import { Decimal } from 'decimal.js';
import pricingData from '../config/pricing.json';

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
  models: Record<
    string,
    {
      deployment_pattern: string;
      input_per_million: number;
      output_per_million: number;
      thinking_tokens_per_million?: number;
      cache_write_per_million?: number;
      cache_read_per_million?: number;
    }
  >;
}

const DEFAULT_PRICING_PATH = new URL('../config/pricing.json', import.meta.url).pathname;

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

function validatePricingPayload(data: unknown): { valid: boolean; reason?: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: 'not_object' };
  }

  const candidate = data as PricingData;
  const models = candidate.models;
  if (typeof candidate.version !== 'string') {
    return { valid: false, reason: 'version' };
  }
  if (candidate.currency !== 'USD') {
    return { valid: false, reason: 'currency' };
  }
  if (!models || typeof models !== 'object') {
    return { valid: false, reason: 'models' };
  }
  if (Object.keys(models).length === 0) {
    return { valid: false, reason: 'empty_models' };
  }

  for (const key of Object.keys(models)) {
    const model = (models as Record<string, unknown>)[key];
    if (!model || typeof model !== 'object') {
      return { valid: false, reason: `model_${key}` };
    }

    const input = Number(Reflect.get(model, 'input_per_million'));
    const output = Number(Reflect.get(model, 'output_per_million'));
    const valid =
      typeof Reflect.get(model, 'deployment_pattern') === 'string' &&
      Number.isFinite(input) &&
      Number.isFinite(output);
    if (!valid) {
      return { valid: false, reason: `model_fields_${key}` };
    }
  }

  return { valid: true };
}

// Initialize pricing cache with hot-reload support
let pricingCache: Map<string, ModelPricing> = normalizePricing(pricingData as PricingData);

async function loadPricingFromFile(filePath: string): Promise<PricingData> {
  const data = await Bun.file(filePath).json();
  const validation = validatePricingPayload(data);
  if (!validation.valid) {
    const candidate = data as Partial<PricingData>;
    throw new Error(
      `Invalid pricing data: reason=${validation.reason}, version=${typeof candidate.version}, currency=${candidate.currency}, models=${candidate.models ? Object.keys(candidate.models).length : 0}`
    );
  }
  return data;
}

/**
 * Reload pricing from a JSON file. Returns false and keeps the last good cache on invalid input.
 */
export async function reloadPricingFromFile(filePath: string): Promise<boolean> {
  try {
    const data = await loadPricingFromFile(filePath);
    pricingCache = normalizePricing(data);
    return true;
  } catch (err) {
    const { logger } = await import('@/observability/logger');
    logger.warn({ err, filePath }, 'Failed to reload pricing data');
    return false;
  }
}

/**
 * Reload pricing from the default JSON file.
 */
export async function reloadPricing(): Promise<boolean> {
  return reloadPricingFromFile(DEFAULT_PRICING_PATH);
}

/**
 * Watch the pricing file and hot-reload validated changes.
 */
export function startPricingWatcher(filePath = DEFAULT_PRICING_PATH): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher: FSWatcher = watch(filePath, () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      reloadPricingFromFile(filePath);
    }, 100);
  });

  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    watcher?.close();
  };
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
    if (deplPattern.endsWith('*') && pattern.startsWith(deplPattern.slice(0, -1))) {
      return pricing;
    }
    if (deplPattern.startsWith('*') && pattern.endsWith(deplPattern.slice(1))) {
      return pricing;
    }
    if (pattern.includes(deplPattern.replace(/\*/g, ''))) {
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
  const inputCost = new Decimal(usage.prompt_tokens).div(1_000_000).times(pricing.inputPerMillion);

  const outputCost = new Decimal(usage.completion_tokens)
    .div(1_000_000)
    .times(pricing.outputPerMillion);

  const thinkingCost =
    pricing.thinkingPerMillion && usage.thinking_tokens
      ? new Decimal(usage.thinking_tokens).div(1_000_000).times(pricing.thinkingPerMillion)
      : new Decimal(0);

  const cacheWriteCost =
    pricing.cacheWritePerMillion && usage.cache_creation_input_tokens
      ? new Decimal(usage.cache_creation_input_tokens)
          .div(1_000_000)
          .times(pricing.cacheWritePerMillion)
      : new Decimal(0);

  const cacheReadCost =
    pricing.cacheReadPerMillion && usage.cache_read_input_tokens
      ? new Decimal(usage.cache_read_input_tokens).div(1_000_000).times(pricing.cacheReadPerMillion)
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
 * Quota multiplier applied to base cost when reserving (`env.QUOTA_MULTIPLIER`,
 * default 1.2). Exported so the fallback top-up path uses the same factor.
 */
export function getQuotaMultiplier(): Decimal {
  return new Decimal(env.QUOTA_MULTIPLIER);
}

/**
 * Calculate estimated cost for reservation (env.QUOTA_MULTIPLIER, default 1.2)
 */
export function calculateEstimatedCost(
  promptTokens: number,
  maxOutputTokens: number,
  model: string,
  thinkingTokens = 0
): Decimal {
  const usage: TokenUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: maxOutputTokens,
    thinking_tokens: thinkingTokens,
  };

  const baseCost = calculateCost(usage, model);

  return baseCost.times(getQuotaMultiplier()).toDecimalPlaces(6);
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
  return validatePricingPayload(pricingData).valid;
}
