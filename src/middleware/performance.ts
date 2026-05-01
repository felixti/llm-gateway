import { recordHttpRequestDuration } from '@/observability/metrics';
import type { Context, Next } from 'hono';

export async function performanceMiddleware(c: Context, next: Next) {
  const startTime = performance.now();

  await next();

  const duration = performance.now() - startTime;
  recordHttpRequestDuration(duration, c.req.method, c.req.path);
}
