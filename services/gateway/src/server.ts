import { serve } from '@hono/node-server';
import { createRemoteJWKSet } from 'jose';
import { createApp } from './app';
import { createConfigStore } from './kernel/config-store';

const configStore = createConfigStore();

const tenant = process.env.AZURE_ENTRA_TENANT_ID ?? '';
const app = createApp({
  auth: {
    orgId: process.env.TENANCY_DEFAULT_ORG ?? 'internal',
    m2m: {
      jwks: createRemoteJWKSet(new URL(process.env.M2M_JWKS_URL ?? `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`)),
      issuer: process.env.M2M_EXPECTED_ISSUER ?? `https://login.microsoftonline.com/${tenant}/v2.0`,
      audience: process.env.M2M_EXPECTED_AUDIENCE ?? 'api://llm-gateway-internal',
      appId: process.env.M2M_EXPECTED_APPID ?? '',
    },
  },
  configStore,
});

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port }, (info) => console.log(`gateway on :${info.port}`));

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
