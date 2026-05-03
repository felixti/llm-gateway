import type { DeploymentConfig } from '@/config/deployments';
import { logRequestAudit } from '@/db/data-access';
import { logger } from '@/observability/logger';
import { addLLMSpanAttributes } from '@/observability/tracing';
import type { ProxyRequestContext } from '@/routes/factories/types';
import type { TokenUsage } from '@/services/pricing.service';
import { reconcileUsage, recordUsageOnly, releaseReservation } from '@/services/quota.service';
import { errorForProtocol } from '@/utils/errors';

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
}: FinalizeUsageOptions): Promise<void> {
  if (!usage) {
    if (reservationId) {
      await releaseReservedQuota(reservationId, requestId);
    }
    return;
  }

  const actualCost = reservationId
    ? await reconcileUsage(reservationId, usage, deployment.azureModelName)
    : await recordUsageOnly(userId || 'unknown', usage, deployment.azureModelName);

  addLLMSpanAttributes({
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.prompt_tokens + usage.completion_tokens,
    costUsd: actualCost.toNumber(),
  });
  logRequestAudit({
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
    durationMs: Date.now() - startTime,
    statusCode: 200,
  }).catch((err) => logger.warn({ err, requestId }, 'Failed to log request audit'));
}
