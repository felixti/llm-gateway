import { serve } from '@hono/node-server';
import { Hono } from 'hono';

// MVP M0 scaffold: the collector drains the usage Storage Queue and ingests
// Usage events into ADX (ADR-0012). That pipeline is implemented in a later
// milestone; this stub exists so the ADR-0014 topology, @shared alias, and CI
// are exercised by a second Node consumer.
const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok', service: 'collector' }));

const port = Number(process.env.PORT ?? 4100);
serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`collector listening on :${info.port}`);
});

export { app };
