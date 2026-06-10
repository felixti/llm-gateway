import { describe, it, expect } from 'vitest';
import type { ModelConfig } from '@shared/contracts/tenant';
import { estimateCost } from './pricing';

const model: ModelConfig = {
  alias: 'gpt-5.4',
  provider: 'azure-openai',
  family: 'openai-chat',
  upstreamApi: 'chat-completions',
  deploymentName: 'gpt-5.4-global',
  enabled: true,
  priceInPerMillion: '5.000000',
  priceOutPerMillion: '15.000000',
};

describe('estimateCost', () => {
  it('computes input + default 50% output in microdollars', () => {
    // 1000 input @ $5/M + 500 output @ $15/M = $0.005 + $0.0075 = $0.0125
    expect(estimateCost(model, 1000)).toBe(12_500n);
  });

  it('accepts explicit output token estimate', () => {
    // 1000 @ $5/M + 1000 @ $15/M = $0.005 + $0.015 = $0.02
    expect(estimateCost(model, 1000, 1000)).toBe(20_000n);
  });
});
