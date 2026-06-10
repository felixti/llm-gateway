import { serve } from '@hono/node-server';
import { createRemoteJWKSet } from 'jose';
import { createUsageQueue } from '@shared/queue/index';
import { createApp } from './app';
import { createBudgetStore } from './kernel/budget-store/store';
import { createConfigStore } from './kernel/config-store';
import { createRedis } from './kernel/redis';
import { createRateStore } from './kernel/rate-store/store';
import { startWalReplayer } from './kernel/wal/wal-replayer';

const configStore = createConfigStore();
const redis = createRedis();
const budgetStore = createBudgetStore(redis);
const rateStore = createRateStore(redis);
const usageQueue = createUsageQueue();

const walReplayer = startWalReplayer({
  queue: usageQueue,
  walDir: process.env.WAL_DIR,
  intervalMs: Number(process.env.WAL_REPLAY_INTERVAL_MS ?? 60_000),
});

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
  budgetStore,
  rateStore,
  redis,
  usageQueue,
  walDir: process.env.WAL_DIR,
  rateLimitRpm: Number(process.env.RATE_LIMIT_RPM ?? 100),
  rateLimitTpm: Number(process.env.RATE_LIMIT_TPM ?? 100_000),
  reservationTtlSec: Number(process.env.BUDGET_RESERVATION_TTL_SEC ?? 300),
  reserveMultiplier: Number(process.env.BUDGET_RESERVE_MULTIPLIER ?? 1.2),
  commitIdempotencyTtlSec: Number(process.env.BUDGET_COMMIT_IDEMPOTENCY_TTL_SEC ?? 604_800),
  upstreamMode: (process.env.UPSTREAM_MODE as 'stub' | 'azure' | undefined) ?? undefined,
});

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port }, (info) => console.log(`gateway on :${info.port}`));

function shutdown() {
  walReplayer.stop();
  redis.disconnect();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
