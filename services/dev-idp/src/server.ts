import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';

const port = Number(process.env.PORT ?? 4000);
const issuer = process.env.DEV_IDP_ISSUER ?? `http://dev-idp:${port}`;

let privateKey: CryptoKey;
let publicJwk: JWK;

async function initKeys() {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = 'compose-dev';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  publicJwk = jwk;
}

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/.well-known/openid-configuration', (c) =>
  c.json({
    issuer,
    jwks_uri: `${issuer}/keys`,
  }),
);

app.get('/keys', (c) => c.json({ keys: [publicJwk] }));

/** Mint RS256 JWTs for local compose E2E (client + YARP M2M). */
app.post('/token', async (c) => {
  const body = (await c.req.json()) as {
    audience?: string;
    claims?: Record<string, unknown>;
    expiresIn?: string;
  };

  const audience = body.audience;
  if (!audience || typeof audience !== 'string') {
    return c.json({ error: 'audience required' }, 400);
  }

  const claims = body.claims ?? {};
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'compose-dev' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(body.expiresIn ?? '1h')
    .sign(privateKey);

  return c.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
});

await initKeys();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`dev-idp on :${info.port} (issuer=${issuer})`);
});
