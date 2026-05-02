import { logger } from '@/observability/logger';
import type { ProxyRequestContext } from '@/routes/factories/types';
import { releaseReservation } from '@/services/quota.service';
import { errorForProtocol } from '@/utils/errors';

interface UpstreamErrorResponseOptions {
  response: Response;
  path: string;
  errorCode: string;
  upstreamName: string;
  requestId: string;
  deploymentName: string;
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

export async function createSanitizedUpstreamErrorResponse({
  response,
  path,
  errorCode,
  upstreamName,
  requestId,
  deploymentName,
}: UpstreamErrorResponseOptions): Promise<Response> {
  let errorBody = '';
  const contentType = response.headers.get('content-type');
  if (contentType && !contentType.includes('application/json')) {
    errorBody = '[non-JSON upstream response]';
  } else {
    try {
      const text = await response.text();
      errorBody = text.slice(0, 4096);
    } catch (err) {
      logger.warn(
        { err, requestId, deployment: deploymentName },
        'Unable to read upstream error body'
      );
    }
  }

  logger.warn(
    {
      requestId,
      deployment: deploymentName,
      upstreamStatus: response.status,
      upstreamContentType: response.headers.get('content-type'),
      upstreamBodyLength: errorBody.length,
    },
    `${upstreamName} upstream request failed`
  );

  const effectiveStatus = response.ok ? 502 : response.status;

  const error = errorForProtocol(
    path,
    effectiveStatus,
    errorCode,
    `${upstreamName} upstream request failed with status ${response.status}.`
  );

  return new Response(JSON.stringify(error), {
    status: effectiveStatus,
    headers: { 'Content-Type': 'application/json' },
  });
}
