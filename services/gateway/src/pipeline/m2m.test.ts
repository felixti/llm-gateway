import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { verifyM2mToken, type M2mVerifyOptions } from './m2m';

let opts: M2mVerifyOptions;
let privateKey: CryptoKey;

const ISS = 'https://login.microsoftonline.com/tenant/v2.0';
const AUD = 'api://llm-gateway-internal';
const APP = 'yarp-app-id';

async function mint(claims: Record<string, unknown>, aud = AUD, iss = ISS) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = 'test'; jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] }) as JWTVerifyGetKey;
  opts = { jwks, issuer: ISS, audience: AUD, appId: APP };
});

describe('verifyM2mToken', () => {
  it('accepts a valid token with matching appid', async () => {
    const r = await verifyM2mToken(await mint({ appid: APP }), opts);
    expect(r.ok && r.value.appId).toBe(APP);
  });
  it('accepts azp when appid absent', async () => {
    const r = await verifyM2mToken(await mint({ azp: APP }), opts);
    expect(r.ok).toBe(true);
  });
  it('rejects wrong audience', async () => {
    const r = await verifyM2mToken(await mint({ appid: APP }, 'api://wrong'), opts);
    expect(r.ok).toBe(false);
  });
  it('rejects wrong appid', async () => {
    const r = await verifyM2mToken(await mint({ appid: 'other' }), opts);
    expect(r.ok).toBe(false);
  });
  it('rejects a garbage token', async () => {
    const r = await verifyM2mToken('not.a.jwt', opts);
    expect(r.ok).toBe(false);
  });
});
