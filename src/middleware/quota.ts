/**
 * Quota Middleware
 * Estimates tokens, reserves quota, handles release on error
 * Supports hard limit (reject with 429) vs soft limit (warn and allow)
 */

import type { Context, Next } from 'hono';
import { calculateEstimatedCost } from '../services/pricing.service';
import {
  type QuotaReservation,
  checkAndReserve,
  getQuotaStatus,
  releaseReservation,
} from '../services/quota.service';
import { errorForProtocol } from '../utils/errors';
import { estimateAnthropicTokens, estimateMessagesTokens } from '../utils/tokens';

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

  if (path.includes('/messages')) {
    // Anthropic Messages API
    const messages = (body as { messages?: Array<unknown> })?.messages || [];
    const thinking = (body as { thinking?: { type?: string } })?.thinking;
    thinkingEnabled = thinking?.type === 'enabled';

    promptTokens = estimateAnthropicTokens(
      messages as Array<{ role?: string; content?: string | Array<unknown> }>,
      model,
      thinkingEnabled
    );
  } else {
    // OpenAI Chat Completions or Responses API
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
export async function quotaMiddleware(c: Context, next: Next): Promise<void> {
  const userId = c.get('userId');
  const model = c.get('model');
  const path = c.req.path;

  // Read body ONCE and reuse - avoid double-read bug
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // Skip if no userId (auth middleware hasn't run)
  if (!userId) {
    await next();
    return;
  }

  // Skip if no model
  if (!model) {
    await next();
    return;
  }

  // Get user's quota status for hard/soft limit check
  const quotaStatus = await getQuotaStatus(userId);
  const isHardLimit = true; // Default to hard limit

  // Estimate tokens from request (synchronous, uses pre-read body)
  const { promptTokens, thinkingEnabled } = estimateRequestTokens(body, path, model);

  // Estimate max output tokens (from request)
  const maxOutputTokens =
    (body as { max_tokens?: number })?.max_tokens ||
    (body as { max_completion_tokens?: number })?.max_completion_tokens ||
    1000;

  // Calculate estimated cost (120% multiplier applied in calculateEstimatedCost)
  const estimatedCost = calculateEstimatedCost(
    promptTokens,
    maxOutputTokens,
    model,
    thinkingEnabled ? Math.ceil(maxOutputTokens * 0.2) : 0
  );

  // Check if quota would exceed budget
  const wouldExceedBudget =
    quotaStatus.spent_usd + quotaStatus.reserved_usd + estimatedCost.toNumber() >
    quotaStatus.monthly_budget_usd;

  if (wouldExceedBudget && isHardLimit) {
    // Hard limit: reject with 429
    const error = errorForProtocol(
      path,
      429,
      'quota_exceeded',
      'Monthly quota exceeded. Please upgrade your plan or wait for reset.'
    );

    c.status(429);
    c.json(error);
    return;
  }

  if (wouldExceedBudget && !isHardLimit) {
    // Soft limit: warn but allow
    c.header(HEADER_WARNING, 'Soft quota limit exceeded. Usage is being tracked.');
  }

  // Attempt to reserve quota
  const reservation = await checkAndReserve(userId, estimatedCost);

  if (!reservation.allowed) {
    // Quota exceeded
    const error = errorForProtocol(
      path,
      429,
      'quota_exceeded',
      reservation.reason || 'Quota reservation failed'
    );

    c.status(429);
    c.json(error);
    return;
  }

  // Store reservation info in context for later use
  if (reservation.reservationId) {
    c.set('reservationId', reservation.reservationId);
  }
  if (reservation.estimatedCost) {
    c.set('estimatedCost', reservation.estimatedCost);
  }
  c.set('model', model);

  // Set quota headers
  setQuotaHeaders(c, reservation, quotaStatus.remaining_usd);

  // Store cleanup on context for error handling
  const cleanup = async () => {
    if (reservation.reservationId) {
      await releaseReservation(reservation.reservationId);
    }
  };

  c.set('releaseQuota', cleanup);

  try {
    await next();
  } catch (error) {
    // Release reservation on error
    await cleanup();
    throw error;
  }
}
