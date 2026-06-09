/**
 * Quota Routes - /quota
 * Returns user's budget/spent/reserved/remaining quota information
 */

import { authMiddleware } from '@/middleware/auth';
import { scopeMiddleware } from '@/middleware/scope';
import { logger } from '@/observability/logger';
import { getQuotaStatus } from '@/services/quota.service';
import { errorForProtocol } from '@/utils/errors';
import { isOk } from '@/utils/result';
import { Hono } from 'hono';

export const quotaRoutes = new Hono();

// Apply auth middleware
quotaRoutes.use('*', authMiddleware);
quotaRoutes.use('*', scopeMiddleware);

// GET /quota
quotaRoutes.get('/', async (c) => {
  const userId = c.get('userId');

  if (!userId) {
    const error = errorForProtocol(
      c.req.path,
      401,
      'authentication_error',
      'User not authenticated'
    );
    c.status(401);
    return c.json(error);
  }

  try {
    const quotaResult = await getQuotaStatus(userId);
    if (!isOk(quotaResult)) {
      logger.error(
        { userId, requestId: c.get('requestId'), error: quotaResult.error },
        'Failed to get quota status'
      );
      const error = errorForProtocol(
        c.req.path,
        429,
        'quota_unavailable',
        'Quota status temporarily unavailable'
      );
      c.status(429);
      return c.json(error);
    }
    return c.json(quotaResult.value);
  } catch (err) {
    logger.error({ err, userId, requestId: c.get('requestId') }, 'Failed to get quota status');
    const error = errorForProtocol(
      c.req.path,
      500,
      'internal_error',
      'Failed to retrieve quota status'
    );
    c.status(500);
    return c.json(error);
  }
});
