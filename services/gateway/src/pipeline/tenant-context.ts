import type { MiddlewareHandler } from 'hono';
import type { TenantContext } from '@shared/contracts/tenant';
import type { ConfigStore } from '../kernel/config-store/types';

export function tenantContextMiddleware(configStore: ConfigStore): MiddlewareHandler {
  return async (c, next) => {
    const userAuth = c.get('userAuth');
    const principal = await configStore.getPrincipal(userAuth.principalId);

    if (!principal) {
      const tenantContext: TenantContext = {
        principalId: userAuth.principalId,
        principalKind: userAuth.principalKind,
        projectId: userAuth.projectId,
        orgId: userAuth.orgId,
        modelAllowlist: [],
        budgetPolicy: null,
      };
      c.set('tenantContext', tenantContext);
      await next();
      return;
    }

    const budgetPolicy =
      principal.kind === 'sp' && principal.projectId
        ? await configStore.getBudgetPolicy(principal.projectId, 'project')
        : principal.kind === 'user'
          ? await configStore.getBudgetPolicy(principal.principalId, 'user')
          : null;

    if (!budgetPolicy) {
      return c.json({ error: 'budget policy not configured' }, 403);
    }

    const tenantContext: TenantContext = {
      principalId: principal.principalId,
      principalKind: principal.kind,
      projectId: principal.projectId,
      orgId: principal.orgId,
      modelAllowlist: principal.modelAllowlist,
      budgetPolicy,
    };
    c.set('tenantContext', tenantContext);
    await next();
  };
}
