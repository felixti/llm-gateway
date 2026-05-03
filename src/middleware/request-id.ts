import { addLLMSpanAttributes, getCurrentTraceId } from '@/observability/tracing';
import type { Context, Next } from 'hono';
import { v4 as uuidv4 } from 'uuid';

const REQUEST_ID_HEADER = 'X-Request-Id';
const TRACE_ID_HEADER = 'X-Trace-Id';

export async function requestIdMiddleware(c: Context, next: Next): Promise<void> {
  const id = uuidv4();
  c.set('requestId', id);
  c.header(REQUEST_ID_HEADER, id);

  const traceId = getCurrentTraceId();
  if (traceId) {
    c.header(TRACE_ID_HEADER, traceId);
    addLLMSpanAttributes({ requestId: id });
  }

  await next();
}
