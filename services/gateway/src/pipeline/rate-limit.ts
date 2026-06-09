import type { MiddlewareHandler } from 'hono';
import { budgetScopeTag } from '@shared/budget/keys';
import type { RateStore } from '../kernel/rate-store/store';
import { estimateRequestTokens } from '../utils/tokens';

export interface RateLimitDeps {
  rateStore: RateStore;
  rpmLimit: number;
  tpmLimit: number;
}

export function rateLimitMiddleware(deps: RateLimitDeps): MiddlewareHandler {
  return async (c, next) => {
    const tenantContext = c.get('tenantContext');
    const scope = budgetScopeTag(tenantContext);
    const tokens = estimateRequestTokens(c.get('parsedBody'), c.get('family'));

    const result = await deps.rateStore.checkAndConsume(scope, deps.rpmLimit, deps.tpmLimit, tokens);
    if (result === 'rpm_exceeded') {
      return c.json({ error: 'rate_limit_exceeded', type: 'rpm_exceeded' }, 429);
    }
    if (result === 'tpm_exceeded') {
      return c.json({ error: 'rate_limit_exceeded', type: 'tpm_exceeded' }, 429);
    }

    await next();
  };
}
