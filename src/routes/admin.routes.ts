/**
 * Admin Routes - /admin
 * PAT revocation and administrative operations
 */

import { logPatRevocation } from '@/db/data-access';
import { redis } from '@/db/redis';
import { requireAdminScopeMiddleware } from '@/middleware/admin-scope';
import { authMiddleware } from '@/middleware/auth';
import { incrementPatRevocationsTotal } from '@/observability/metrics';
import { hashJtiForBlocklist } from '@/utils/auth';
import { errorForProtocol } from '@/utils/errors';
import { Hono } from 'hono';
import { z } from 'zod';

// Zod schema for PAT revocation request
const revokePatBodySchema = z.object({
  pat_id: z.string().uuid('pat_id must be a valid UUID'),
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

  // Persist until deleted — aligns with JWT exp / explicit unblock flows
  const blocklistKey = `blocklist:pat:${hashJtiForBlocklist(pat_id)}`;
  await redis.set(blocklistKey, '1');

  incrementPatRevocationsTotal();
  try {
    await logPatRevocation({
      patId: pat_id,
      revokedBy,
      reason,
    });
  } catch (err) {
    console.error('Failed to log PAT revocation to PostgreSQL:', err);
    // Continue anyway - Redis blocklist is the primary mechanism
  }

  return c.json({
    success: true,
    message: 'PAT token revoked successfully',
    pat_id,
  });
});
