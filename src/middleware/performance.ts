import { incrementHttpRequests, recordHttpRequestDuration } from '@/observability/metrics';
import type { Context, Next } from 'hono';

export async function performanceMiddleware(c: Context, next: Next) {
  const startTime = performance.now();

  await next();

  const duration = performance.now() - startTime;
  const status = c.res?.status ?? 0;
  incrementHttpRequests(c.req.method, c.req.path, status);
  recordHttpRequestDuration(duration, c.req.method, c.req.path);
}
