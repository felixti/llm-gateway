import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type Redis from 'ioredis';
import { fromMicrodollars } from '@shared/budget/money';
import type { UsageQueue } from '@shared/queue/types';
import './types';
import { healthRoutes } from './features/health/route';
import type { BudgetStore } from './kernel/budget-store/store';
import type { ConfigStore } from './kernel/config-store/types';
import type { RateStore } from './kernel/rate-store/store';
import { authMiddleware, type AuthDeps } from './pipeline/auth';
import { budgetMiddleware } from './pipeline/budget';
import { buildUsageEvent, emitUsageEvent } from './pipeline/meter';
import { protocolGuard, type Family } from './pipeline/protocol-guard';
import { rateLimitMiddleware } from './pipeline/rate-limit';
import { scopeMiddleware } from './pipeline/scope';
import { tenantContextMiddleware } from './pipeline/tenant-context';
import { estimateRequestTokens } from './utils/tokens';

export interface AppDeps {
  auth: AuthDeps;
  configStore: ConfigStore;
  budgetStore: BudgetStore;
  rateStore: RateStore;
  redis: Redis;
  usageQueue: UsageQueue;
  walDir?: string;
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
      const startedAt = Date.now();
      const requestId = c.req.header('x-request-id') ?? randomUUID();

      let redisCommitResult: 'ok' | 'failed' = 'ok';
      try {
        await deps.budgetStore.commit(
          c.get('budgetScope'),
          c.get('reservationId'),
          requestId,
          c.get('reservedMicro'),
          deps.commitIdempotencyTtlSec,
        );
      } catch {
        redisCommitResult = 'failed';
      }

      const modelConfig = await deps.configStore.getModel(c.get('model'));
      if (!modelConfig) {
        return c.json({ error: 'model not found' }, 400);
      }

      const tokensPrompt = estimateRequestTokens(c.get('parsedBody'), c.get('family'));
      const tokensCompletion = Math.ceil(tokensPrompt / 2);
      const costUsd = fromMicrodollars(c.get('reservedMicro'));

      const event = buildUsageEvent({
        requestId,
        userAuth: c.get('userAuth'),
        tenantContext: c.get('tenantContext'),
        modelConfig,
        tokensPrompt,
        tokensCompletion,
        costUsd,
        status: 'completed',
        latencyMs: Date.now() - startedAt,
        redisCommitResult,
        reservationId: c.get('reservationId'),
        scope: c.get('budgetScope'),
      });

      await emitUsageEvent(
        { usageQueue: deps.usageQueue, walDir: deps.walDir },
        event,
      );

      return c.json({
        stub: true,
        model: c.get('model'),
        principal: c.get('userAuth').principalId,
        request_id: requestId,
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
