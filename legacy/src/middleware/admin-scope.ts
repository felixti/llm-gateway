import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env';
import { errorForProtocol } from '@/utils/errors';
import type { Context, Next } from 'hono';

const HEADER_OPERATOR_SECRET = 'x-operator-secret';

let _cachedRotated: string | null = null;

/**
 * Uses validated `env.ADMIN_OPERATOR_SECRET` as primary source.
 * When process.env diverges (live rotation), re-validates min 16 chars and adopts.
 * Returns `null` when not configured.
 */
function getOperatorSecret(): string | null {
  const validated = env.ADMIN_OPERATOR_SECRET ?? null;

  const raw = process.env.ADMIN_OPERATOR_SECRET ?? '';
  if (!raw) {
    _cachedRotated = null;
    return null;
  }

  if (raw === validated) return validated;

  // process.env diverged from validated config → rotation in progress
  if (raw.length < 16) {
    throw new Error('ADMIN_OPERATOR_SECRET is set but too short (minimum 16 characters)');
  }

  _cachedRotated = raw;
  return _cachedRotated;
}

function isOperatorSecretValid(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;

  // Use HMAC with PAT_SECRET as key for constant-time comparison
  // This avoids timing side channels regardless of input length
  const providedHash = createHmac('sha256', env.PAT_SECRET).update(provided).digest();
  const expectedHash = createHmac('sha256', env.PAT_SECRET).update(expected).digest();

  return timingSafeEqual(providedHash, expectedHash);
}

export async function requireAdminScopeMiddleware(
  c: Context,
  next: Next
): Promise<Response | undefined> {
  const path = c.req.path;

  let operatorSecret: string | null;
  try {
    operatorSecret = getOperatorSecret();
  } catch {
    return c.json(
      errorForProtocol(path, 403, 'configuration_error', 'Operator secret is misconfigured'),
      403
    );
  }

  if (operatorSecret !== null) {
    const provided = c.req.header(HEADER_OPERATOR_SECRET);
    if (!isOperatorSecretValid(provided, operatorSecret)) {
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
