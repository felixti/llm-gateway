/**
 * PAT Authentication Middleware
 * Verifies Bearer token format: lg_{userId}_{header}.{payload}.{signature}
 * Checks Redis blocklist and token expiry
 */

import { redis } from '@/db/redis';
import { type PatToken, hashJtiForBlocklist, validatePatStructure } from '@/utils/auth';
import { errorForProtocol } from '@/utils/errors';
import { type Result, err, isOk, ok } from '@/utils/result';
import type { Context, Next } from 'hono';

const HEADER_AUTHORIZATION = 'Authorization';
const BEARER_PREFIX = 'Bearer ';

// Context keys
export const USER_ID_KEY = 'userId';
export const SCOPE_KEY = 'scope';
export const JTI_KEY = 'jti';
export const PAT_TOKEN_KEY = 'patToken';

/**
 * Result type for auth validation steps
 */
type AuthResult<T> = Result<T, { code: string; message: string }>;

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader: string | undefined): AuthResult<string> {
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return err({
      code: 'authentication_error',
      message: 'Missing or invalid Authorization header',
    });
  }
  return ok(authHeader.slice(BEARER_PREFIX.length)) as AuthResult<string>;
}

/**
 * Validate PAT token structure
 */
function validateToken(rawToken: string): AuthResult<PatToken> {
  const validation = validatePatStructure(rawToken);
  if (!validation.valid || !validation.token) {
    return err({ code: 'authentication_error', message: validation.error || 'Invalid PAT token' });
  }
  return ok(validation.token) as AuthResult<PatToken>;
}

/**
 * JWT payload structure
 */
interface JwtPayload {
  jti: string;
  exp: number;
  scope?: string;
}

/**
 * Parse JWT payload to extract jti and exp
 */
function parseJwtPayload(payloadB64: string): AuthResult<JwtPayload> {
  try {
    const padded = payloadB64.padEnd(payloadB64.length + ((4 - (payloadB64.length % 4)) % 4), '=');
    const decoded = JSON.parse(atob(padded)) as { jti?: string; exp?: number; scope?: string };
    const jti = decoded.jti || '';
    const exp = decoded.exp || 0;
    const scope = decoded.scope;

    if (!jti) {
      return err({ code: 'authentication_error', message: 'Invalid token payload' });
    }
    return ok({ jti, exp, scope }) as AuthResult<JwtPayload>;
  } catch {
    return err({ code: 'authentication_error', message: 'Invalid token payload' });
  }
}

/**
 * Check if token is expired
 */
function checkExpiry(exp: number): AuthResult<void> {
  const now = Math.floor(Date.now() / 1000);
  if (exp && exp < now) {
    return err({ code: 'authentication_error', message: 'Token has expired' });
  }
  return ok(undefined) as AuthResult<void>;
}

/**
 * Check blocklist in Redis
 */
async function checkBlocklist(jti: string): Promise<AuthResult<void>> {
  const key = `blocklist:pat:${hashJtiForBlocklist(jti)}`;
  const result = await redis.get(key);
  if (result) {
    return err({ code: 'authentication_error', message: 'Token has been revoked' });
  }
  return ok(undefined) as AuthResult<void>;
}

/**
 * PAT Authentication Middleware
 * Validates token, checks blocklist, sets context variables
 */
export async function authMiddleware(c: Context, next: Next): Promise<Response | undefined> {
  const path = c.req.path;
  const authHeader = c.req.header(HEADER_AUTHORIZATION);

  // Pipeline of validation steps using Result
  const tokenResult = extractBearerToken(authHeader);
  if (!isOk(tokenResult)) {
    return c.json(
      errorForProtocol(path, 401, tokenResult.error.code, tokenResult.error.message),
      401
    );
  }

  const patResult = validateToken(tokenResult.value);
  if (!isOk(patResult)) {
    return c.json(errorForProtocol(path, 401, patResult.error.code, patResult.error.message), 401);
  }

  const token = patResult.value;
  const payloadResult = parseJwtPayload(token.payload);
  if (!isOk(payloadResult)) {
    return c.json(
      errorForProtocol(path, 401, payloadResult.error.code, payloadResult.error.message),
      401
    );
  }

  const payload = payloadResult.value;
  const expiryResult = checkExpiry(payload.exp);
  if (!isOk(expiryResult)) {
    return c.json(
      errorForProtocol(path, 401, expiryResult.error.code, expiryResult.error.message),
      401
    );
  }

  const blocklistResult = await checkBlocklist(payload.jti);
  if (!isOk(blocklistResult)) {
    return c.json(
      errorForProtocol(path, 401, blocklistResult.error.code, blocklistResult.error.message),
      401
    );
  }

  c.set(USER_ID_KEY, token.userId);
  c.set(JTI_KEY, payload.jti);
  c.set(SCOPE_KEY, payload.scope || 'all');
  c.set(PAT_TOKEN_KEY, token);

  await next();
}
