import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type Redis from 'ioredis';
import './types';
import { healthRoutes } from './features/health/route';
import type { BudgetStore } from './kernel/budget-store/store';
import type { ConfigStore } from './kernel/config-store/types';
import type { RateStore } from './kernel/rate-store/store';
import { authMiddleware, type AuthDeps } from './pipeline/auth';
import { budgetMiddleware } from './pipeline/budget';
import { protocolGuard, type Family } from './pipeline/protocol-guard';
import { rateLimitMiddleware } from './pipeline/rate-limit';
import { scopeMiddleware } from './pipeline/scope';
import { tenantContextMiddleware } from './pipeline/tenant-context';

export interface AppDeps {
  auth: AuthDeps;
  configStore: ConfigStore;
  budgetStore: BudgetStore;
  rateStore: RateStore;
  redis: Redis;
  rateLimitRpm: number;
  rateLimitTpm: number;
  reservationTtlSec: number;
  reserveMultiplier: number;
  commitIdempotencyTtlSec: number;
}

function registerLlmRoute(api: Hono, deps: AppDeps, path: string, family: Family) {
  api.post(
    path,
    protocolGuard(family),
    scopeMiddleware(),
    rateLimitMiddleware({
      rateStore: deps.rateStore,
      rpmLimit: deps.rateLimitRpm,
      tpmLimit: deps.rateLimitTpm,
    }),
    budgetMiddleware({
      budgetStore: deps.budgetStore,
      configStore: deps.configStore,
      redis: deps.redis,
      reservationTtlSec: deps.reservationTtlSec,
      reserveMultiplier: deps.reserveMultiplier,
    }),
    async (c) => {
      const requestId = c.req.header('x-request-id') ?? randomUUID();
      await deps.budgetStore.commit(
        c.get('budgetScope'),
        c.get('reservationId'),
        requestId,
        c.get('reservedMicro'),
        deps.commitIdempotencyTtlSec,
      );
      return c.json({
        stub: true,
        model: c.get('model'),
        principal: c.get('userAuth').principalId,
      });
    },
  );
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.route('/', healthRoutes);

  const api = new Hono();
  api.use('*', authMiddleware(deps.auth));
  api.use('*', tenantContextMiddleware(deps.configStore));

  registerLlmRoute(api, deps, '/v1/chat/completions', 'openai-chat');
  registerLlmRoute(api, deps, '/v1/messages', 'anthropic-messages');

  app.route('/', api);
  return app;
}
