import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type Redis from 'ioredis';
import { budgetScopeTag } from '@shared/budget/keys';
import { multiplyMicro } from '@shared/budget/money';
import type { BudgetStore } from '../kernel/budget-store/store';
import type { ConfigStore } from '../kernel/config-store/types';
import { syncBudgetPolicy } from '../kernel/policy-sync';
import { estimateCost } from '../utils/pricing';
import { estimateRequestTokens } from '../utils/tokens';

export interface BudgetDeps {
  budgetStore: BudgetStore;
  configStore: ConfigStore;
  redis: Redis;
  reservationTtlSec: number;
  reserveMultiplier: number;
}

export function budgetMiddleware(deps: BudgetDeps): MiddlewareHandler {
  return async (c, next) => {
    const tenantContext = c.get('tenantContext');
    const budgetPolicy = tenantContext.budgetPolicy;
    if (!budgetPolicy) {
      return c.json({ error: 'budget policy not configured' }, 403);
    }

    const scope = budgetScopeTag(tenantContext);
    await syncBudgetPolicy(deps.redis, scope, budgetPolicy);

    const modelAlias = c.get('model');
    const modelConfig = await deps.configStore.getModel(modelAlias);
    if (!modelConfig) {
      return c.json({ error: 'model not found' }, 400);
    }

    const inputTokens = estimateRequestTokens(c.get('parsedBody'), c.get('family'));
    const estimatedMicro = estimateCost(modelConfig, inputTokens);
    const reservedMicro = multiplyMicro(estimatedMicro, deps.reserveMultiplier);

    const reservationId = randomUUID();
    const result = await deps.budgetStore.reserve(
      scope,
      reservationId,
      reservedMicro,
      deps.reservationTtlSec,
    );
    if (result === 'insufficient') {
      return c.json({ error: 'insufficient_quota' }, 429);
    }

    c.set('reservationId', reservationId);
    c.set('budgetScope', scope);
    c.set('reservedMicro', reservedMicro);
    await next();
  };
}
