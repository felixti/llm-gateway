/**
 * PAT token generator for integration tests.
 * Creates syntactically valid, signed PAT tokens using the test PAT_SECRET.
 */

import { createHmac } from 'node:crypto';
import { env } from '@/config/env';

function base64UrlNoPadding(data: string): string {
  return Buffer.from(data).toString('base64url').replace(/=+$/, '');
}

export function createTestPat(
  userId: string,
  options: { jti?: string; exp?: number; scope?: string } = {}
): string {
  const jti = options.jti || 'test-jti';
  const exp = options.exp || Math.floor(Date.now() / 1000) + 3600;
  const scope = options.scope || 'all';

  const header = `lg_${userId}_${base64UrlNoPadding(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}`;
  const payload = base64UrlNoPadding(JSON.stringify({ jti, exp, scope }));

  const signature = createHmac('sha256', env.PAT_SECRET)
    .update(`${header}.${payload}`)
    .digest('hex');

  return `Bearer ${header}.${payload}.${signature}`;
}

export const INVALID_PAT = 'Bearer invalid_token_format';
