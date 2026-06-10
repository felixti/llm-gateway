import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { UsageQueue } from '@shared/queue/types';
import './types';
import { loadAzureEnv } from './config/azure-env';
import { createLlmHandler, resolveUpstreamClient, type UpstreamMode } from './features/llm/handler';
import { healthRoutes } from './features/health/route';
import type { BudgetStore } from './kernel/budget-store/store';
import type { ConfigStore } from './kernel/config-store/types';
import type { RateStore } from './kernel/rate-store/store';
import type { UpstreamClient } from './providers/upstream-client';
import { authMiddleware, type AuthDeps } from './pipeline/auth';
import { budgetMiddleware } from './pipeline/budget';
import { openAiRouteGuard, responsesRouteGuard } from './pipeline/protocol-guard';
import { rateLimitMiddleware } from './pipeline/rate-limit';
import { scopeMiddleware } from './pipeline/scope';
import { tenantContextMiddleware } from './pipeline/tenant-context';
import type { RouteProtocol } from './protocol/responses-chat-bridge';

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
  upstreamClient?: UpstreamClient;
  upstreamMode?: UpstreamMode;
}

function registerLlmRoute(
  api: Hono,
  deps: AppDeps,
  path: string,
  route: RouteProtocol,
  upstreamClient: UpstreamClient,
  upstreamMode: UpstreamMode,
) {
  const guard = route === 'openai-responses' ? responsesRouteGuard() : openAiRouteGuard();

  api.post(
    path,
    guard,
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
    createLlmHandler(
      {
        configStore: deps.configStore,
        budgetStore: deps.budgetStore,
        usageQueue: deps.usageQueue,
        walDir: deps.walDir,
        commitIdempotencyTtlSec: deps.commitIdempotencyTtlSec,
      },
      route,
      upstreamClient,
      upstreamMode,
    ),
  );
}

export function createApp(deps: AppDeps) {
  const azureEnv = loadAzureEnv();
  const { client: upstreamClient, mode: upstreamMode } = resolveUpstreamClient(
    azureEnv,
    deps.upstreamMode,
    deps.upstreamClient,
  );

  const app = new Hono();
  app.route('/', healthRoutes);

  const api = new Hono();
  api.use('*', authMiddleware(deps.auth));
  api.use('*', tenantContextMiddleware(deps.configStore));

  registerLlmRoute(api, deps, '/v1/chat/completions', 'openai-chat', upstreamClient, upstreamMode);
  registerLlmRoute(api, deps, '/v1/responses', 'openai-responses', upstreamClient, upstreamMode);
  registerLlmRoute(api, deps, '/v1/messages', 'openai-chat', upstreamClient, upstreamMode);

  app.route('/', api);
  return app;
}
