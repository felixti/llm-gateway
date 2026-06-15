import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import '../types';
import { authMiddleware, type AuthDeps } from './auth';

const ISS = 'https://issuer/v2.0', AUD = 'api://llm-gateway-internal', APP = 'yarp';
let deps: AuthDeps;
let privateKey: CryptoKey;

const mint = (extra: Record<string, unknown> = {}) =>
  new SignJWT({ appid: APP, ...extra }).setProtectedHeader({ alg: 'RS256', kid: 't' })
    .setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime('5m').sign(privateKey);

function appWith(deps: AuthDeps) {
  const app = new Hono();
  app.use('*', authMiddleware(deps));
  app.get('/probe', (c) => c.json({ principal: c.get('userAuth').principalId }));
  return app;
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey); jwk.kid = 't'; jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] }) as JWTVerifyGetKey;
  deps = { orgId: 'internal', m2m: { jwks, issuer: ISS, audience: AUD, appId: APP } };
});

describe('authMiddleware', () => {
  it('401 when no bearer token', async () => {
    const res = await appWith(deps).request('/probe');
    expect(res.status).toBe(401);
  });
  it('200 + userAuth set with valid token + claims', async () => {
    const res = await appWith(deps).request('/probe', {
      headers: { authorization: `Bearer ${await mint()}`, 'x-principal-id': 'oid9', 'x-principal-kind': 'user' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ principal: 'oid9' });
  });
  it('401 when token valid but claims malformed (bad kind)', async () => {
    const res = await appWith(deps).request('/probe', {
      headers: { authorization: `Bearer ${await mint()}`, 'x-principal-id': 'x', 'x-principal-kind': 'robot' },
    });
    expect(res.status).toBe(401);
  });
});
