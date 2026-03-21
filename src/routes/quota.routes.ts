/**
 * Quota Routes - /quota
 * Returns user's budget/spent/reserved/remaining quota information
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { getQuotaStatus } from '../services/quota.service';
import { errorForProtocol } from '../utils/errors';

export const quotaRoutes = new Hono();

// Apply auth middleware
quotaRoutes.use('*', authMiddleware);

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
    const quotaStatus = await getQuotaStatus(userId);
    return c.json(quotaStatus);
  } catch (err) {
    console.error('Failed to get quota status:', err);
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
