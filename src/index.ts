import { Hono } from 'hono';
import { env } from './config/env';
import { closeDatabase } from './db/client';
import { closeRedis } from './db/redis';
import { requestIdMiddleware } from './middleware/request-id';
import { initTracing, shutdownTracing } from './observability/tracing';
import { adminRoutes } from './routes/admin.routes';
import { chatRoutes } from './routes/chat.routes';
import { healthRoutes } from './routes/health.routes';
import { messagesRoutes } from './routes/messages.routes';
import { modelsRoutes } from './routes/models.routes';
import { quotaRoutes } from './routes/quota.routes';
import { responsesRoutes } from './routes/responses.routes';
import { startHealthChecks, stopHealthChecks } from './services/health.service';
import { startBackgroundJobs, stopBackgroundJobs } from './services/scheduler.service';

const app = new Hono();

app.use('*', requestIdMiddleware);

app.route('/v1/chat/completions', chatRoutes);
app.route('/v1/messages', messagesRoutes);
app.route('/v1/responses', responsesRoutes);
app.route('/v1/models', modelsRoutes);
app.route('/', healthRoutes);
app.route('/quota', quotaRoutes);
app.route('/admin', adminRoutes);

let server: ReturnType<typeof Bun.serve> | null = null;

async function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}, starting graceful shutdown...`);

  stopHealthChecks();
  stopBackgroundJobs();

  if (server) {
    server.stop(true);
  }

  await shutdownTracing();
  await closeRedis();
  await closeDatabase();

  console.log('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const port = env.PORT;

initTracing();
startHealthChecks();
startBackgroundJobs();

server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`LLM Gateway running on port ${port}`);
