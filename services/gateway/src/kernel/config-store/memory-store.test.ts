import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryConfigStore } from './memory-store';

describe('createMemoryConfigStore', () => {
  const store = () => createMemoryConfigStore();

  it('getModel returns seeded gpt-5.4', async () => {
    const model = await store().getModel('gpt-5.4');
    expect(model).toMatchObject({
      alias: 'gpt-5.4',
      provider: 'azure-openai',
      family: 'openai-chat',
      enabled: true,
    });
  });

  it('getModel unknown returns null', async () => {
    expect(await store().getModel('unknown-model')).toBeNull();
  });

  it('getPrincipal seed-sp-appid returns correct allowlist', async () => {
    const principal = await store().getPrincipal('seed-sp-appid');
    expect(principal).toEqual({
      principalId: 'seed-sp-appid',
      kind: 'sp',
      projectId: 'seed-project',
      orgId: 'internal',
      modelAllowlist: ['gpt-5.4', 'claude-opus-4-6'],
    });
  });

  it('getPrincipal unknown returns null', async () => {
    expect(await store().getPrincipal('unknown-principal')).toBeNull();
  });

  it('getBudgetPolicy returns policy for seeded principal', async () => {
    const policy = await store().getBudgetPolicy('seed-user-oid', 'user');
    expect(policy).toMatchObject({
      principalId: 'seed-user-oid',
      scopeKind: 'user',
      period: 'monthly',
      hard: true,
    });
    expect(policy?.capUsd).toBeTruthy();
  });

  it('getBudgetPolicy unknown returns null', async () => {
    expect(await store().getBudgetPolicy('unknown', 'user')).toBeNull();
  });

  it('bumpConfigVersion increments getConfigVersion', async () => {
    const s = store();
    expect(await s.getConfigVersion()).toBe(1);
    expect(await s.bumpConfigVersion()).toBe(2);
    expect(await s.getConfigVersion()).toBe(2);
  });
});
