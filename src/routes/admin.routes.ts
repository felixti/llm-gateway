/**
 * Admin Routes - /admin
 * PAT revocation and administrative operations
 */

import { getApiKeyByJti, logPatRevocation } from '@/db/data-access';
import { redis } from '@/db/redis';
import { requireAdminScopeMiddleware } from '@/middleware/admin-scope';
import { authMiddleware } from '@/middleware/auth';
import { logger } from '@/observability/logger';
import { incrementPatRevocationsTotal } from '@/observability/metrics';
import { hashJtiForBlocklist } from '@/utils/auth';
import { errorForProtocol } from '@/utils/errors';
import { Hono } from 'hono';
import { z } from 'zod';

// Zod schema for PAT revocation request
const revokePatBodySchema = z.object({
  pat_id: z.string().min(1, 'pat_id must be a non-empty string'),
  reason: z.string().optional(),
});

export const adminRoutes = new Hono();

// Apply auth + admin scope (revocation is never allowed with `all` or `read` PATs)
adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', requireAdminScopeMiddleware);

// POST /admin/pat/revoke
adminRoutes.post('/pat/revoke', async (c) => {
  // Parse body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    const error = errorForProtocol(c.req.path, 400, 'invalid_request', 'Invalid JSON body');
    c.status(400);
    return c.json(error);
  }

  // Validate body
  const parsed = revokePatBodySchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    const error = errorForProtocol(
      c.req.path,
      400,
      'invalid_request',
      `${firstError.path.join('.')}: ${firstError.message}`
    );
    c.status(400);
    return c.json(error);
  }

  const { pat_id, reason } = parsed.data;
  const revokedBy = c.get('userId');

  if (!revokedBy) {
    const error = errorForProtocol(c.req.path, 401, 'authentication_error', 'Not authenticated');
    c.status(401);
    return c.json(error);
  }

  let keyRecord: { id: string; jti: string } | null;
  try {
    keyRecord = await getApiKeyByJti(pat_id);
  } catch (error) {
    logger.error({ patId: pat_id, error }, 'Database error during PAT lookup');
    return c.json(
      errorForProtocol(c.req.path, 500, 'internal_error', 'Internal server error'),
      500
    );
  }

  if (!keyRecord) {
    return c.json(
      errorForProtocol(c.req.path, 404, 'not_found', 'PAT not found or already revoked'),
      404
    );
  }

  const blocklistKey = `blocklist:pat:${hashJtiForBlocklist(keyRecord.jti)}`;
  await redis.set(blocklistKey, '1');

  incrementPatRevocationsTotal();
  try {
    await logPatRevocation({
      patId: pat_id,
      revokedBy,
      reason,
    });
  } catch (err) {
    logger.warn({ err, patId: pat_id, revokedBy }, 'Failed to log PAT revocation to PostgreSQL');
    // Continue anyway - Redis blocklist is the primary mechanism
  }

  return c.json({
    success: true,
    message: 'PAT token revoked successfully',
    pat_id,
  });
});
