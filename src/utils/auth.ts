/**
 * PAT Authentication Utility
 * HMAC-SHA256 based PAT verification - never stores raw tokens
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env';

/**
 * PAT token format: lg_{userId}_{header}.{payload}.{signature}
 */
export interface PatToken {
  userId: string;
  header: string;
  payload: string;
  signature: string;
  raw: string;
}

/**
 * Parse PAT token without validation
 * Does NOT return the raw token - only parsed components
 */
export function parsePatToken(rawToken: string): PatToken | null {
  const parts = rawToken.split('.');

  if (parts.length !== 3) {
    return null;
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const headerMatch = headerB64.match(/^lg_(.+?)_/);

  if (!headerMatch) {
    return null;
  }

  const userId = headerMatch[1];

  return {
    userId,
    header: headerB64,
    payload: payloadB64,
    signature: signatureB64,
    // SECURITY: Never store the raw token
    raw: '', // Empty string - raw token is never retained
  };
}

/**
 * Verify PAT token structure and signature
 * Uses HMAC-SHA256 signature verification (not stored-hash comparison)
 * because the PAT format embeds the signature in the token itself
 */
export function validatePatStructure(rawToken: string): {
  valid: boolean;
  token?: PatToken;
  error?: string;
} {
  const token = parsePatToken(rawToken);

  if (!token) {
    return { valid: false, error: 'Invalid PAT format' };
  }

  // Verify signature
  const expectedSignature = createHmac('sha256', env.PAT_SECRET)
    .update(`${token.header}.${token.payload}`)
    .digest('hex');

  const signatureBuffer = Buffer.from(token.signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (signatureBuffer.length !== expectedBuffer.length) {
    return { valid: false, error: 'Invalid signature length' };
  }

  try {
    if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return { valid: false, error: 'Invalid signature' };
    }
  } catch {
    return { valid: false, error: 'Signature comparison failed' };
  }

  // SECURITY: Return token without raw value
  return {
    valid: true,
    token: {
      userId: token.userId,
      header: token.header,
      payload: token.payload,
      signature: token.signature,
      raw: '', // Raw token is never returned
    },
  };
}

/**
 * Check if a JTI (JWT ID) is blocklisted
 * Returns hash for comparison, not the raw token
 */
export async function isJtiBlocklisted(
  jti: string,
  blocklistGetter: (jti: string) => Promise<string | null>
): Promise<boolean> {
  const storedHash = await blocklistGetter(jti);

  if (!storedHash) {
    return false;
  }

  // Compare hash of provided JTI with stored hash
  const jtiHash = createHmac('sha256', env.PAT_SECRET).update(jti).digest('hex');

  try {
    const a = Buffer.from(jtiHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Generate a blocklist hash for a JTI
 * This is what we STORE in Redis - never the raw JTI
 */
export function hashJtiForBlocklist(jti: string): string {
  return createHmac('sha256', env.PAT_SECRET).update(jti).digest('hex');
}
