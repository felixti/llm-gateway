import Decimal from 'decimal.js';
import type { ModelConfig } from '@shared/contracts/tenant';
import { toMicrodollars } from '@shared/budget/money';

export function estimateCost(
  model: ModelConfig,
  inputTokens: number,
  outputTokensEstimate?: number,
): bigint {
  const outputTokens = outputTokensEstimate ?? Math.ceil(inputTokens * 0.5);
  const inputCost = new Decimal(inputTokens).div(1_000_000).mul(model.priceInPerMillion);
  const outputCost = new Decimal(outputTokens).div(1_000_000).mul(model.priceOutPerMillion);
  return toMicrodollars(inputCost.plus(outputCost).toFixed(6));
}
