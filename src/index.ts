import { Hono } from 'hono';
import { compress } from 'hono-compress';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { env } from './config/env';
import { closeDatabase } from './db/client';
import { closeRedis } from './db/redis';
import { performanceMiddleware } from './middleware/performance';
import { requestIdMiddleware } from './middleware/request-id';
import { timeoutMiddleware } from './middleware/timeout';
import { logger } from './observability/logger';
import { initMetrics, shutdownMetrics } from './observability/metrics';
import { initTracing, shutdownTracing } from './observability/tracing';
import { adminRoutes } from './routes/admin.routes';
import { chatRoutes } from './routes/chat.routes';
import { healthRoutes } from './routes/health.routes';
import { messagesRoutes } from './routes/messages.routes';
import { modelsRoutes } from './routes/models.routes';
import { quotaRoutes } from './routes/quota.routes';
import { responsesRoutes } from './routes/responses.routes';
import { startHealthChecks, stopHealthChecks } from './services/health.service';
import { startPricingWatcher } from './services/pricing.service';
import { startBackgroundJobs, stopBackgroundJobs } from './services/scheduler.service';
import {
  getInFlightCount,
  initiateGracefulShutdown,
  shutdownMiddleware,
} from './services/shutdown.service';
import { errorForProtocol } from './utils/errors';

const app = new Hono();

app.use('*', compress());

app.use(
  '*',
  secureHeaders({
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: 'cross-origin',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'no-referrer',
  })
);

const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(/,/ as RegExp).map((s) => s.trim());
app.use(
  '*',
  cors({
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposeHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
    maxAge: 86400,
  })
);

app.use('*', requestIdMiddleware);
app.use('*', shutdownMiddleware);
app.use('*', timeoutMiddleware);
app.use('*', performanceMiddleware);

app.onError((err, c) => {
  const requestId = c.get('requestId') || 'unknown';
  logger.error({ err, requestId }, 'Unhandled error');

  const error = errorForProtocol(c.req.path, 500, 'internal_error', 'Internal server error');
  return c.json(error, 500);
});

app.route('/v1/chat/completions', chatRoutes);
app.route('/v1/messages', messagesRoutes);
app.route('/v1/responses', responsesRoutes);
app.route('/v1/models', modelsRoutes);
app.route('/', healthRoutes);
app.route('/quota', quotaRoutes);
app.route('/admin', adminRoutes);

let server: ReturnType<typeof Bun.serve> | null = null;
let stopPricingWatcher: (() => void) | null = null;

async function gracefulShutdown(signal: string) {
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

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const port = env.PORT;

initMetrics();
initTracing();
startHealthChecks();
startBackgroundJobs();
stopPricingWatcher = startPricingWatcher();

server = Bun.serve({
  port,
  fetch: app.fetch,
  maxRequestBodySize: env.BODY_SIZE_LIMIT_BYTES,
});

logger.info({ port, maxRequestBodySize: env.BODY_SIZE_LIMIT_BYTES }, 'LLM Gateway started');
