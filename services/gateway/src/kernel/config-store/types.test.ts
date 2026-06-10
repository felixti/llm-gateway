import { describe, it, expect } from 'vitest';
import type { ModelConfig, TenantContext } from '@shared/contracts/tenant';

describe('tenant types', () => {
  it('ModelConfig shape is usable', () => {
    const m: ModelConfig = {
      alias: 'gpt-5.4',
      provider: 'azure-openai',
      family: 'openai-chat',
      upstreamApi: 'chat-completions',
      deploymentName: 'gpt-5.4-global',
      enabled: true,
      priceInPerMillion: '0.150000',
      priceOutPerMillion: '0.600000',
    };
    expect(m.alias).toBe('gpt-5.4');
  });

  it('TenantContext shape is usable', () => {
    const t: TenantContext = {
      principalId: 'app1',
      principalKind: 'sp',
      projectId: 'proj1',
      orgId: 'internal',
      modelAllowlist: ['gpt-5.4'],
      budgetPolicy: null,
    };
    expect(t.modelAllowlist).toHaveLength(1);
  });
});
