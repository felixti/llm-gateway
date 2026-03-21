/**
 * PAT Authentication Middleware
 * Verifies Bearer token format: lg_{userId}_{header}.{payload}.{signature}
 * Checks Redis blocklist and token expiry
 */

import type { Context, Next } from "hono";
import { redis } from "../db/redis";
import { validatePatStructure, hashJtiForBlocklist, type PatToken } from "../utils/auth";
import { errorForProtocol } from "../utils/errors";

const HEADER_AUTHORIZATION = "Authorization";
const BEARER_PREFIX = "Bearer ";

// Context keys
export const USER_ID_KEY = "userId";
export const SCOPE_KEY = "scope";
export const JTI_KEY = "jti";
export const PAT_TOKEN_KEY = "patToken";

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return authHeader.slice(BEARER_PREFIX.length);
}

/**
 * Parse JWT payload to extract jti and exp
 */
function parseJwtPayload(payloadB64: string): { jti: string; exp: number } | null {
  try {
    // Add padding if needed
    const padded = payloadB64.padEnd(payloadB64.length + ((4 - (payloadB64.length % 4)) % 4), "=");
    const decoded = JSON.parse(atob(padded));
    return {
      jti: decoded.jti || "",
      exp: decoded.exp || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Get blocklist entry from Redis
 */
async function getBlocklistEntry(jti: string): Promise<string | null> {
  const key = `blocklist:pat:${hashJtiForBlocklist(jti)}`;
  const result = await redis.get(key);
  return result ?? null;
}

/**
 * PAT Authentication Middleware
 * Validates token, checks blocklist, sets context variables
 */
export async function authMiddleware(
  c: Context,
  next: Next
): Promise<void> {
  const authHeader = c.req.header(HEADER_AUTHORIZATION);
  const rawToken = extractBearerToken(authHeader);

  if (!rawToken) {
    const error = errorForProtocol(
      c.req.path,
      401,
      "authentication_error",
      "Missing or invalid Authorization header"
    );
    c.status(401);
    c.json(error);
    return;
  }

  // Validate token structure and signature
  const validation = validatePatStructure(rawToken);

  if (!validation.valid || !validation.token) {
    const error = errorForProtocol(
      c.req.path,
      401,
      "authentication_error",
      validation.error || "Invalid PAT token"
    );
    c.status(401);
    c.json(error);
    return;
  }

  const token: PatToken = validation.token;

  // Parse JWT payload for jti and exp
  const payload = parseJwtPayload(token.payload);

  if (!payload || !payload.jti) {
    const error = errorForProtocol(
      c.req.path,
      401,
      "authentication_error",
      "Invalid token payload"
    );
    c.status(401);
    c.json(error);
    return;
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    const error = errorForProtocol(
      c.req.path,
      401,
      "authentication_error",
      "Token has expired"
    );
    c.status(401);
    c.json(error);
    return;
  }

  // Check blocklist
  const isBlocklisted = await getBlocklistEntry(payload.jti);

  if (isBlocklisted) {
    const error = errorForProtocol(
      c.req.path,
      401,
      "authentication_error",
      "Token has been revoked"
    );
    c.status(401);
    c.json(error);
    return;
  }

  // Set context variables for downstream middleware/handlers
  c.set(USER_ID_KEY, token.userId);
  c.set(JTI_KEY, payload.jti);
  c.set(SCOPE_KEY, "all"); // TODO: Extract scope from token payload
  c.set(PAT_TOKEN_KEY, token);

  await next();
}
