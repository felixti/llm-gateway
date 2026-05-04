import { createApp } from './app';
import { env } from './config/env';
import { closeDatabase } from './db/client';
import { closeRedis } from './db/redis';
import { logger } from './observability/logger';
import { initMetrics, shutdownMetrics } from './observability/metrics';
import { initTracing, shutdownTracing } from './observability/tracing';
import { startHealthChecks, stopHealthChecks } from './services/health.service';
import { startPricingWatcher } from './services/pricing.service';
import { startBackgroundJobs, stopBackgroundJobs } from './services/scheduler.service';
import { getInFlightCount, initiateGracefulShutdown } from './services/shutdown.service';

type GatewayServer = ReturnType<typeof Bun.serve>;

let server: GatewayServer | null = null;
let stopPricingWatcher: (() => void) | null = null;

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown...');

  stopHealthChecks();
  stopBackgroundJobs();
  stopPricingWatcher?.();

  if (server) {
    server.stop(false);
    logger.info({ inFlight: getInFlightCount() }, 'Stopped accepting new connections');

    const drained = await initiateGracefulShutdown(server);
    if (!drained) {
      logger.warn({ inFlight: getInFlightCount() }, 'Shutdown timeout reached, forcing exit');
    }
  } else {
    await initiateGracefulShutdown();
  }

  await shutdownMetrics();
  await shutdownTracing();
  await closeRedis();
  await closeDatabase();

  logger.info('Shutdown complete');
  process.exit(0);
}

export function registerShutdownHandlers(): void {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

export function startServer(): GatewayServer {
  initMetrics();
  initTracing();
  startHealthChecks();
  startBackgroundJobs();
  stopPricingWatcher = startPricingWatcher();

  const app = createApp();
  const port = env.PORT;

  server = Bun.serve({
    port,
    fetch: app.fetch,
    maxRequestBodySize: env.BODY_SIZE_LIMIT_BYTES,
  });

  logger.info({ port, maxRequestBodySize: env.BODY_SIZE_LIMIT_BYTES }, 'LLM Gateway started');
  return server;
}

if (import.meta.main) {
  registerShutdownHandlers();
  startServer();
}
