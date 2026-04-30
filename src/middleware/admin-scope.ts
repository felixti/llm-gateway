/**
 * Requires PAT scope `admin` for operator routes (e.g. PAT revocation).
 * Run after authMiddleware.
 */

import { errorForProtocol } from '@/utils/errors';
import type { Context, Next } from 'hono';

const HEADER_OPERATOR_SECRET = 'x-operator-secret';

/** Read live so deployment can rotate the secret without process restart and tests can set it per case. */
function getOperatorSecret(): string | undefined {
  const raw = process.env.ADMIN_OPERATOR_SECRET;
  return raw && raw.length >= 16 ? raw : undefined;
}

export async function requireAdminScopeMiddleware(
  c: Context,
  next: Next
): Promise<Response | undefined> {
  const path = c.req.path;

  const operatorSecret = getOperatorSecret();
  if (operatorSecret) {
    const provided = c.req.header(HEADER_OPERATOR_SECRET);
    if (provided !== operatorSecret) {
      return c.json(
        errorForProtocol(path, 403, 'permission_error', 'Invalid operator credentials'),
        403
      );
    }
  }

  const scope = c.get('scope');

  if (scope !== 'admin') {
    return c.json(
      errorForProtocol(path, 403, 'permission_error', 'Admin scope is required for this operation'),
      403
    );
  }

  await next();
}
