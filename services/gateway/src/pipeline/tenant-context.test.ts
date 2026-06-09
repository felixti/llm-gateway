import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { UserAuth } from '@shared/contracts/claims';
import type { PrincipalRecord } from '@shared/contracts/tenant';
import '../types';
import { createMemoryConfigStore } from '../kernel/config-store/memory-store';
import { createSeedData } from '../kernel/config-store/seed';
import { tenantContextMiddleware } from './tenant-context';

function appWith(userAuth: UserAuth, store = createMemoryConfigStore()) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('userAuth', userAuth);
    await next();
  });
  a.use('*', tenantContextMiddleware(store));
  a.get('/probe', (c) => c.json(c.get('tenantContext')));
  return a;
}

describe('tenantContextMiddleware', () => {
  it('resolves allowlist + budget for app1 seeded principal', async () => {
    const res = await appWith({
      principalId: 'app1',
      principalKind: 'sp',
      projectId: 'proj1',
      orgId: 'internal',
      scopes: [],
    }).request('/probe');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principalId: 'app1',
      principalKind: 'sp',
      projectId: 'proj1',
      orgId: 'internal',
      modelAllowlist: ['gpt-5.4', 'claude-opus-4-6'],
      budgetPolicy: {
        principalId: 'proj1',
        scopeKind: 'project',
        capUsd: '100.000000',
        period: 'monthly',
        hard: true,
      },
    });
  });

  it('unknown principal → empty allowlist (still sets tenantContext)', async () => {
    const res = await appWith({
      principalId: 'unknown-principal',
      principalKind: 'user',
      projectId: null,
      orgId: 'internal',
      scopes: [],
    }).request('/probe');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principalId: 'unknown-principal',
      principalKind: 'user',
      projectId: null,
      orgId: 'internal',
      modelAllowlist: [],
      budgetPolicy: null,
    });
  });

  it('missing budget policy → 403', async () => {
    const principal: PrincipalRecord = {
      principalId: 'no-budget-user',
      kind: 'user',
      projectId: null,
      orgId: 'internal',
      modelAllowlist: ['gpt-5-mini'],
    };
    const store = createMemoryConfigStore({
      ...createSeedData(),
      principals: [...createSeedData().principals, principal],
      budgets: createSeedData().budgets,
    });

    const res = await appWith(
      {
        principalId: 'no-budget-user',
        principalKind: 'user',
        projectId: null,
        orgId: 'internal',
        scopes: [],
      },
      store,
    ).request('/probe');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'budget policy not configured' });
  });

  it('SP uses project-scoped budget', async () => {
    const res = await appWith({
      principalId: 'seed-sp-appid',
      principalKind: 'sp',
      projectId: 'seed-project',
      orgId: 'internal',
      scopes: [],
    }).request('/probe');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.budgetPolicy).toEqual({
      principalId: 'seed-project',
      scopeKind: 'project',
      capUsd: '100.000000',
      period: 'monthly',
      hard: true,
    });
    expect(body.modelAllowlist).toEqual(['gpt-5.4', 'claude-opus-4-6']);
  });
});
