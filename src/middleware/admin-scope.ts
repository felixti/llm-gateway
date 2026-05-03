/**
 * Requires PAT scope `admin` for operator routes (e.g. PAT revocation).
 * Run after authMiddleware.
 */

import { timingSafeEqual } from 'node:crypto';
import { errorForProtocol } from '@/utils/errors';
import type { Context, Next } from 'hono';

const HEADER_OPERATOR_SECRET = 'x-operator-secret';

/** Read live so deployment can rotate the secret without process restart and tests can set it per case. */
function getOperatorSecret(): string {
  const raw = process.env.ADMIN_OPERATOR_SECRET;
  if (!raw || raw.length < 16) {
    throw new Error('ADMIN_OPERATOR_SECRET is not configured or too short');
  }
  return raw;
}

function isOperatorSecretValid(provided: string | undefined, expected: string): boolean {
  if (!provided) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function requireAdminScopeMiddleware(
  c: Context,
  next: Next
): Promise<Response | undefined> {
  const path = c.req.path;

  let operatorSecret: string;
  try {
    operatorSecret = getOperatorSecret();
  } catch {
    return c.json(
      errorForProtocol(path, 403, 'configuration_error', 'Operator secret is not configured'),
      403
    );
  }

  const provided = c.req.header(HEADER_OPERATOR_SECRET);
  if (!isOperatorSecretValid(provided, operatorSecret)) {
    return c.json(
      errorForProtocol(path, 403, 'permission_error', 'Invalid operator credentials'),
      403
    );
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
