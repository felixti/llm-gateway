import { randomUUID } from 'node:crypto';

import type {
  RedisCommitResult,
  UsageEvent,
  UsageEventStatus,
} from '@shared/contracts/usage-event';
import type { UserAuth } from '@shared/contracts/claims';
import type { ModelConfig, TenantContext } from '@shared/contracts/tenant';
import type { UsageQueue } from '@shared/queue/types';

import { writeUsageWalEntry } from '../kernel/wal/usage-wal';

export interface MeterDeps {
  usageQueue: UsageQueue;
  walDir?: string;
}

export function buildUsageEvent(params: {
  requestId: string;
  attempt?: number;
  userAuth: UserAuth;
  tenantContext: TenantContext;
  modelConfig: ModelConfig;
  tokensPrompt: number;
  tokensCompletion: number;
  costUsd: string;
  status: UsageEventStatus;
  latencyMs: number;
  redisCommitResult: RedisCommitResult;
  reservationId: string;
  scope: string;
}): UsageEvent {
  const tokensTotal = params.tokensPrompt + params.tokensCompletion;
  return {
    request_id: params.requestId,
    event_id: randomUUID(),
    attempt: params.attempt ?? 0,
    ts: new Date().toISOString(),
    principal_id: params.userAuth.principalId,
    principal_kind: params.userAuth.principalKind,
    ...(params.userAuth.projectId ? { project_id: params.userAuth.projectId } : {}),
    model: params.modelConfig.alias,
    deployment: params.modelConfig.deploymentName,
    provider: params.modelConfig.provider,
    tokens_prompt: params.tokensPrompt,
    tokens_completion: params.tokensCompletion,
    tokens_total: tokensTotal,
    cost_usd: params.costUsd,
    status: params.status,
    latency_ms: params.latencyMs,
    redis_commit_result: params.redisCommitResult,
    reservation_id: params.reservationId,
    scope: params.scope,
  };
}

export async function emitUsageEvent(deps: MeterDeps, event: UsageEvent): Promise<'queued' | 'wal'> {
  try {
    await deps.usageQueue.enqueue(JSON.stringify(event));
    return 'queued';
  } catch {
    await writeUsageWalEntry(event, deps.walDir);
    return 'wal';
  }
}
