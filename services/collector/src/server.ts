import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createUsageQueue } from '@shared/queue/index';
import { startCollectorWorker } from './worker';

const queue = createUsageQueue();
const outDir = process.env.COLLECTOR_OUT_DIR ?? '/tmp/collector-out';
const workerEnabled = process.env.COLLECTOR_WORKER_ENABLED !== 'false';

const worker = workerEnabled
  ? startCollectorWorker({
      queue,
      outDir,
      intervalMs: Number(process.env.COLLECTOR_POLL_INTERVAL_MS ?? 5_000),
      batchSize: Number(process.env.COLLECTOR_BATCH_SIZE ?? 32),
    })
  : null;

const app = new Hono();

app.get('/health', (c) => {
  const stats = worker?.getStats() ?? {
    queueDepthHint: 0,
    batchesWritten: 0,
    lastBatchAt: null,
  };
  return c.json({
    status: 'ok',
    service: 'collector',
    queue_depth_hint: stats.queueDepthHint,
    batches_written: stats.batchesWritten,
    last_batch_at: stats.lastBatchAt,
  });
});

const port = Number(process.env.PORT ?? 4100);
const server = serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`collector listening on :${info.port}`);
});

function shutdown() {
  worker?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app };
