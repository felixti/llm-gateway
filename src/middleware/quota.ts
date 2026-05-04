/**
 * Quota Middleware
 * Estimates tokens, reserves quota, handles release on error
 * Supports hard limit (reject with 429) vs soft limit (warn and allow)
 */

import { env } from '@/config/env';
import {
  incrementQuotaExceeded429,
  incrementQuotaHydrationFailures,
  incrementQuotaReservationNull,
} from '@/observability/metrics';
import { calculateEstimatedCost } from '@/services/pricing.service';
import {
  type QuotaReservation,
  type QuotaResult,
  checkAndReserve,
  getQuotaStatus,
  releaseReservation,
} from '@/services/quota.service';
import { errorForProtocol } from '@/utils/errors';
import { isOk } from '@/utils/result';
import { estimateAnthropicTokens, estimateMessagesTokens } from '@/utils/tokens';
import type { Context, Next } from 'hono';

// Header constants
const HEADER_QUOTA_REMAINING = 'X-Quota-Remaining';
const HEADER_QUOTA_RESERVED = 'X-Quota-Reserved';
const HEADER_WARNING = 'X-Warning';

/**
 * Extract token estimate from request based on protocol
 */
function estimateRequestTokens(
  body: Record<string, unknown>,
  path: string,
  model: string
): {
  promptTokens: number;
  thinkingEnabled: boolean;
} {
  let promptTokens = 0;
  let thinkingEnabled = false;

  if (path.includes('/responses')) {
    const input = (body as { input?: string | Array<{ role?: string; content?: string }> }).input;
    if (typeof input === 'string') {
      promptTokens = estimateMessagesTokens([{ role: 'user', content: input }], model);
    } else if (Array.isArray(input)) {
      promptTokens = estimateMessagesTokens(
        input.map((m) => ({
          role: m.role ?? 'user',
          content: typeof m.content === 'string' ? m.content : '',
        })),
        model
      );
    }
  } else if (path.includes('/messages')) {
    const messages = (body as { messages?: Array<unknown> })?.messages || [];
    const thinking = (body as { thinking?: { type?: string } })?.thinking;
    thinkingEnabled = thinking?.type === 'enabled';

    promptTokens = estimateAnthropicTokens(
      messages as Array<{ role?: string; content?: string | Array<unknown> }>,
      model,
      thinkingEnabled
    );
  } else {
    const messages = (body as { messages?: Array<unknown> })?.messages || [];
    promptTokens = estimateMessagesTokens(
      messages as Array<{ role?: string; content?: string }>,
      model
    );
  }

  return { promptTokens, thinkingEnabled };
}

/**
 * Set quota headers on response
 */
function setQuotaHeaders(c: Context, reservation: QuotaReservation, remaining: number): void {
  c.header(HEADER_QUOTA_REMAINING, String(Math.max(0, Number(remaining.toFixed(6)))));
  if (reservation.reservationId) {
    c.header(HEADER_QUOTA_RESERVED, reservation.reservationId);
  }
}

/**
 * Quota middleware
 * Estimates tokens, reserves quota, handles release on error
 */
export async function quotaMiddleware(c: Context, next: Next): Promise<Response | undefined> {
  const userId = c.get('userId');
  const model = c.get('model');
  const path = c.req.path;

  if (path === '/v1/messages/count_tokens' || path === '/count_tokens') {
    await next();
    return;
  }

  const cached = c.get('parsedBody') as Record<string, unknown> | undefined;
  if (!cached || typeof cached !== 'object') {
    const error = errorForProtocol(path, 400, 'invalid_request', 'Invalid or missing request body');
    return c.json(error, 400);
  }
  const body = cached;

  if (!userId) {
    await next();
    return;
  }

  if (!model) {
    const error = errorForProtocol(
      path,
      400,
      'invalid_request',
      'Model is required for quota enforcement'
    );
    return c.json(error, 400);
  }

  // Get quota status - fail closed if Redis error
  const quotaStatusResult: QuotaResult = await getQuotaStatus(userId);

  // Fail closed: if we cannot determine quota status, reject the request
  if (!isOk(quotaStatusResult)) {
    const error = errorForProtocol(
      path,
      429,
      'quota_unavailable',
      'Unable to determine quota status. Please try again later.'
    );
    incrementQuotaHydrationFailures();
    return c.json(error, 429);
  }

  const quotaStatus = quotaStatusResult.value;
  const isHardLimit = !env.QUOTA_SOFT_LIMIT_ENABLED && quotaStatus.hard_limit;

  const { promptTokens, thinkingEnabled } = estimateRequestTokens(body, path, model);

  const maxOutputTokens =
    (body as { max_tokens?: number })?.max_tokens ||
    (body as { max_completion_tokens?: number })?.max_completion_tokens ||
    1000;

  const estimatedCost = calculateEstimatedCost(
    promptTokens,
    maxOutputTokens,
    model,
    thinkingEnabled ? Math.ceil(maxOutputTokens * 0.2) : 0
  );

  const wouldExceedBudget =
    quotaStatus.spent_usd + quotaStatus.reserved_usd + estimatedCost.toNumber() >
    quotaStatus.monthly_budget_usd;

  if (wouldExceedBudget && isHardLimit) {
    const error = errorForProtocol(
      path,
      429,
      'quota_exceeded',
      'Monthly quota exceeded. Please upgrade your plan or wait for reset.'
    );
    incrementQuotaExceeded429();
    return c.json(error, 429);
  }

  if (wouldExceedBudget && !isHardLimit) {
    c.header(HEADER_WARNING, 'Soft quota limit exceeded. Usage is being tracked.');
    c.header(HEADER_QUOTA_REMAINING, '0');
  }

  const reservation = await checkAndReserve(userId, estimatedCost);

  if (!reservation.allowed) {
    const error = errorForProtocol(
      path,
      429,
      'quota_exceeded',
      reservation.reason || 'Quota reservation failed'
    );
    incrementQuotaExceeded429();
    return c.json(error, 429);
  }

  if (reservation.reservationId) {
    c.set('reservationId', reservation.reservationId);
  } else {
    incrementQuotaReservationNull();
  }
  if (reservation.estimatedCost) {
    c.set('estimatedCost', reservation.estimatedCost);
  }
  c.set('model', model);

  setQuotaHeaders(
    c,
    reservation,
    wouldExceedBudget && !isHardLimit ? 0 : quotaStatus.remaining_usd
  );

  let released = false;
  const cleanup = async () => {
    if (released) {
      return;
    }
    released = true;
    if (reservation.reservationId) {
      await releaseReservation(reservation.reservationId);
    }
  };

  c.set('releaseQuota', cleanup);

  try {
    await next();
    if (c.res?.status && c.res.status >= 400) {
      await cleanup();
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
}
