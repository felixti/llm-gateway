import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey, type KeyLike } from 'jose';
import { createApp, type AppDeps } from './app';
import { createMemoryConfigStore } from './kernel/config-store/memory-store';

const ISS = 'https://issuer/v2.0', AUD = 'api://llm-gateway-internal', APP = 'yarp';
let deps: AppDeps;
let privateKey: KeyLike;
const mint = () => new SignJWT({ appid: APP }).setProtectedHeader({ alg: 'RS256', kid: 't' })
  .setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime('5m').sign(privateKey);

beforeAll(async () => {
  const kp = await generateKeyPair('RS256'); privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey); jwk.kid = 't'; jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] }) as JWTVerifyGetKey;
  deps = {
    auth: { orgId: 'internal', m2m: { jwks, issuer: ISS, audience: AUD, appId: APP } },
    configStore: createMemoryConfigStore(),
  };
});

const authd = async (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${await mint()}`, 'content-type': 'application/json',
  'x-principal-id': 'app1', 'x-principal-kind': 'sp', 'x-principal-project': 'proj1', ...extra,
});

describe('end-to-end pipeline', () => {
  it('401 unauthenticated chat', async () => {
    const res = await createApp(deps).request('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
  it('200 stub for allowed chat model', async () => {
    const res = await createApp(deps).request('/v1/chat/completions', {
      method: 'POST', headers: await authd(), body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stub: true, model: 'gpt-5.4', principal: 'app1' });
  });
  it('200 stub for allowed messages model', async () => {
    const res = await createApp(deps).request('/v1/messages', {
      method: 'POST', headers: await authd(), body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    });
    expect(res.status).toBe(200);
  });
  it('403 for disallowed model', async () => {
    const res = await createApp(deps).request('/v1/chat/completions', {
      method: 'POST', headers: await authd(), body: JSON.stringify({ model: 'gpt-5-mini' }),
    });
    expect(res.status).toBe(403);
  });
});
