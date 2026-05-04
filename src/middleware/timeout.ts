import { env } from '@/config/env';
import { logger } from '@/observability/logger';
import { errorForProtocol } from '@/utils/errors';
import type { Context, Next } from 'hono';

/** Context key for the request-scoped AbortSignal (timeout-aware). */
export const REQUEST_SIGNAL_KEY = 'requestSignal';

/**
 * Forward `source.aborted` to `controller`. Returns a cleanup function that
 * detaches the listener to avoid retaining the upstream signal.
 */
function forwardAbort(source: AbortSignal, controller: AbortController): () => void {
  if (source.aborted) {
    controller.abort(source.reason);
    return () => {};
  }

  const onAbort = () => controller.abort(source.reason);
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

function isEventStreamResponse(response: Response | undefined): response is Response {
  return (
    response?.body !== null &&
    response?.headers.get('Content-Type')?.includes('text/event-stream') === true
  );
}

function wrapBodyWithCleanup(
  body: ReadableStream<Uint8Array>,
  cleanup: () => void
): ReadableStream<Uint8Array> {
  let cleaned = false;
  let streamReader: {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock: () => void;
    cancel: (reason?: unknown) => Promise<void>;
  } | null = null;
  const runCleanup = () => {
    if (!cleaned) {
      cleaned = true;
      cleanup();
    }
  };

  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      streamReader = reader;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            break;
          }
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      } finally {
        runCleanup();
        reader.releaseLock();
      }
    },
    cancel(reason) {
      runCleanup();
      return streamReader?.cancel(reason);
    },
  });
}

function deferAbortDetachUntilStreamEnds(
  response: Response,
  detachClientAbort: () => void
): Response {
  if (!response.body) {
    return response;
  }

  return new Response(wrapBodyWithCleanup(response.body, detachClientAbort), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Timeout middleware.
 *
 * Creates a request-scoped AbortController linked to the incoming request's
 * abort signal plus a timer for {@link env.REQUEST_TIMEOUT_MS}. The resulting
 * signal is exposed via `c.get(REQUEST_SIGNAL_KEY)` and MUST be forwarded to
 * upstream `fetch` calls so that a gateway timeout cancels outbound work
 * (prevents wasted Azure tokens on abandoned requests).
 *
 * The middleware also races `next()` against the timeout so that a hung
 * handler which does not respect the signal still returns a 504 to the
 * client within the budget.
 */
export async function timeoutMiddleware(c: Context, next: Next): Promise<Response | undefined> {
  const requestTimeoutMs = env.REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const detachClientAbort = forwardAbort(c.req.raw.signal, controller);
  let detachInFinally = true;

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<'__timeout__'>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Request timeout after ${requestTimeoutMs}ms`));
      resolve('__timeout__');
    }, requestTimeoutMs);
  });

  c.set(REQUEST_SIGNAL_KEY, controller.signal);

  try {
    const winner = await Promise.race([next().then(() => '__next__' as const), timeoutPromise]);

    if (winner === '__timeout__' || timedOut) {
      logger.warn(
        { path: c.req.path, method: c.req.method, timeoutMs: requestTimeoutMs },
        'Request timeout'
      );
      const timeoutError = errorForProtocol(
        c.req.path,
        504,
        'gateway_timeout',
        `Request timeout after ${requestTimeoutMs}ms`
      );
      return c.json(timeoutError, 504);
    }

    if (isEventStreamResponse(c.res)) {
      c.res = deferAbortDetachUntilStreamEnds(c.res, detachClientAbort);
      detachInFinally = false;
      return undefined;
    }

    return undefined;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    if (detachInFinally) {
      detachClientAbort();
    }
  }
}
