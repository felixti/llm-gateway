import type { DeploymentConfig } from '@/config/deployments';
import { type AuditWriteResult, insertRequestAuditOrThrow } from '@/db/data-access';
import { logger } from '@/observability/logger';
import {
  addLlmCost,
  addLlmTokens,
  incrementUnbilledRequests,
  recordLlmRequestDuration,
} from '@/observability/metrics';
import { addLLMSpanAttributes } from '@/observability/tracing';
import type { ProxyRequestContext } from '@/routes/factories/types';
import { type TokenUsage, calculateCost } from '@/services/pricing.service';
import { reconcileUsage, recordUsageOnly, releaseReservation } from '@/services/quota.service';
import { writeWalEntry } from '@/services/wal.service';
import { errorForProtocol } from '@/utils/errors';
import { isOk } from '@/utils/result';
import type { Decimal } from 'decimal.js';

const PG_AUDIT_RETRIES = 3;
const PG_AUDIT_BACKOFF_MS = [200, 400, 800];

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function logRequestAuditDurable(
  payload: Parameters<typeof insertRequestAuditOrThrow>[0],
  signal?: AbortSignal
): Promise<AuditWriteResult | 'failed'> {
  for (let attempt = 0; attempt < PG_AUDIT_RETRIES; attempt++) {
    if (signal?.aborted) return 'failed';
    try {
      return await insertRequestAuditOrThrow(payload);
    } catch (err) {
      logger.warn(
        { err, requestId: payload.requestId, attempt: attempt + 1 },
        'Postgres audit insert failed, retrying'
      );
      if (attempt < PG_AUDIT_RETRIES - 1) {
        await sleepWithAbort(PG_AUDIT_BACKOFF_MS[attempt], signal);
      }
    }
  }
  return 'failed';
}

interface UpstreamErrorResponseOptions {
  response?: Response;
  path: string;
  errorCode: string;
  upstreamName: string;
  requestId: string;
  deploymentName: string;
}

interface FinalizeUsageOptions {
  usage: TokenUsage | undefined;
  reservationId: string;
  requestId: string;
  userId: string | undefined;
  deployment: DeploymentConfig;
  startTime: number;
  thinkingEnabled?: boolean;
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
}

export function normalizeProxyContext(
  contextOrReservationId: ProxyRequestContext | string,
  requestId?: string
): ProxyRequestContext {
  if (typeof contextOrReservationId === 'string') {
    return { reservationId: contextOrReservationId, requestId: requestId || '' };
  }
  return contextOrReservationId;
}

export async function releaseReservedQuota(
  reservationId: string,
  requestId: string
): Promise<void> {
  if (!reservationId) {
    return;
  }

  try {
    await releaseReservation(reservationId);
  } catch (err) {
    logger.warn({ err, requestId, reservationId }, 'Failed to release quota reservation');
  }
}

export function redactSensitiveContent(text: string): string {
  return text
    .replace(/"key"\s*:\s*"[^"]+"/gi, '"key":"[REDACTED]"')
    .replace(/"api[_-]?key"\s*:\s*"[^"]+"/gi, '"api_key":"[REDACTED]"')
    .replace(/Bearer\s+[a-zA-Z0-9_-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '[API_KEY]')
    .replace(/\b[a-f0-9]{32}\b/gi, '[AZURE_KEY]');
}

export async function createSanitizedUpstreamErrorResponse({
  response,
  path,
  errorCode,
  upstreamName,
  requestId,
  deploymentName,
}: UpstreamErrorResponseOptions): Promise<Response> {
  let errorBody = '';
  let upstreamStatus = 502;

  if (response) {
    upstreamStatus = response.status;
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('application/json')) {
      errorBody = '[non-JSON upstream response]';
    } else {
      try {
        const text = await response.text();
        errorBody = redactSensitiveContent(text).slice(0, 1024);
      } catch (err) {
        logger.warn(
          { err, requestId, deployment: deploymentName },
          'Unable to read upstream error body'
        );
      }
    }
  } else {
    errorBody = '[network error - no upstream response]';
  }

  logger.warn(
    {
      requestId,
      deployment: deploymentName,
      upstreamStatus,
      upstreamContentType: response?.headers?.get('content-type') ?? null,
      upstreamBodyLength: errorBody.length,
    },
    `${upstreamName} upstream request failed`
  );

  const effectiveStatus = response ? (response.ok ? 502 : response.status) : 502;

  const error = errorForProtocol(
    path,
    effectiveStatus,
    errorCode,
    `${upstreamName} upstream request failed with status ${upstreamStatus}.`
  );

  return new Response(JSON.stringify(error), {
    status: effectiveStatus,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function finalizeProxyUsage({
  usage,
  reservationId,
  requestId,
  userId,
  deployment,
  startTime,
  thinkingEnabled = false,
  idempotencyKey,
  abortSignal,
}: FinalizeUsageOptions): Promise<void> {
  if (!usage) {
    if (reservationId) {
      await releaseReservedQuota(reservationId, requestId);
    }
    return;
  }

  const actualCost: Decimal = calculateCost(usage, deployment.azureModelName);

  let redisOk = true;
  if (reservationId) {
    const costResult = await reconcileUsage(reservationId, usage, deployment.azureModelName);
    if (!isOk(costResult)) {
      redisOk = false;
      logger.warn(
        { err: costResult.error, reservationId: costResult.error.reservationId, requestId },
        'Quota reconciliation failed - reconciler job will rebuild from Postgres'
      );
    }
  } else {
    try {
      await recordUsageOnly(userId || 'unknown', usage, deployment.azureModelName, idempotencyKey);
    } catch (err) {
      redisOk = false;
      logger.warn({ err, requestId }, 'recordUsageOnly failed - reconciler will rebuild');
    }
  }

  addLLMSpanAttributes({
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.prompt_tokens + usage.completion_tokens,
    costUsd: actualCost.toNumber(),
  });

  addLlmTokens(usage.prompt_tokens, usage.completion_tokens, deployment.azureModelName);
  addLlmCost(actualCost.toNumber(), deployment.azureModelName);
  recordLlmRequestDuration(
    Date.now() - startTime,
    deployment.azureModelName,
    deployment.protocolFamily
  );

  const durationMs = Date.now() - startTime;
  const auditResult = await logRequestAuditDurable(
    {
      userId: userId || 'unknown',
      requestId,
      model: deployment.azureModelName,
      deployment: deployment.name,
      protocolFamily: deployment.protocolFamily,
      tokensInput: usage.prompt_tokens,
      tokensOutput: usage.completion_tokens,
      tokensThinking: usage.thinking_tokens || 0,
      costUsd: actualCost.toString(),
      thinkingEnabled,
      azureAuthType: deployment.authConfig.type,
      durationMs,
      statusCode: 200,
    },
    abortSignal
  );

  if (auditResult === 'failed') {
    const reason: 'redis_fail' | 'pg_fail' | 'both_fail' = redisOk ? 'pg_fail' : 'both_fail';
    try {
      await writeWalEntry({
        requestId,
        userId: userId || 'unknown',
        model: deployment.azureModelName,
        deployment: deployment.name,
        protocolFamily: deployment.protocolFamily,
        azureAuthType: deployment.authConfig.type,
        thinkingEnabled,
        durationMs,
        statusCode: 200,
        tokensInput: usage.prompt_tokens,
        tokensOutput: usage.completion_tokens,
        tokensThinking: usage.thinking_tokens || 0,
        costUsd: actualCost.toString(),
        timestamp: new Date().toISOString(),
        reason,
      });
    } catch (err) {
      logger.error({ err, requestId }, 'WAL write failed - data loss possible');
    }
    incrementUnbilledRequests(reason);

    if (!redisOk) {
      const error = new Error('Quota reconciliation and audit both failed');
      error.name = 'QuotaReconciliationError';
      throw error;
    }
  }
}
