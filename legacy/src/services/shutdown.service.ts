/**
 * Graceful Shutdown Service
 * Tracks in-flight requests and drains them before shutdown
 */

import { env } from '@/config/env';
import { logger } from '@/observability/logger';
import type { Context, Next } from 'hono';

let inFlightCount = 0;
let shuttingDown = false;

/** Resolvers waiting for in-flight count to reach zero */
const drainResolvers: Array<{ resolve: () => void }> = [];

function incrementInFlight(): void {
  inFlightCount++;
}

function decrementInFlight(): void {
  inFlightCount = Math.max(0, inFlightCount - 1);

  if (shuttingDown && inFlightCount === 0) {
    const resolvers = drainResolvers.splice(0);
    for (const { resolve } of resolvers) {
      resolve();
    }
  }
}

function trackResponseBody(body: ReadableStream<Uint8Array>, onDone: () => void): ReadableStream {
  const reader = body.getReader();
  let done = false;

  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    onDone();
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}

/**
 * Returns the current number of in-flight requests.
 */
export function getInFlightCount(): number {
  return inFlightCount;
}

/**
 * Returns true once shutdown has been initiated.
 * @internal
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Hono middleware that tracks in-flight requests.
 * Increments on request start, decrements on completion (including errors).
 * Rejects new requests with 503 once shutdown is in progress.
 */
export async function shutdownMiddleware(c: Context, next: Next): Promise<Response | undefined> {
  if (shuttingDown) {
    return c.json(
      {
        error: {
          message: 'Server is shutting down',
          type: 'server_error',
          code: 'shutting_down',
        },
      },
      503
    );
  }

  incrementInFlight();
  let decrementOnReturn = true;

  try {
    await next();
    const response = c.res;
    if (response.body) {
      decrementOnReturn = false;
      c.res = new Response(trackResponseBody(response.body, decrementInFlight), response);
    }
  } finally {
    if (decrementOnReturn) {
      decrementInFlight();
    }
  }
}

/**
 * Wait for all in-flight requests to complete, or until timeout.
 * @param timeoutMs - Maximum time to wait in milliseconds (defaults to env.SHUTDOWN_TIMEOUT_MS)
 * @returns true if all requests drained, false if timed out
 * @internal
 */
export function waitForDrain(timeoutMs: number = env.SHUTDOWN_TIMEOUT_MS): Promise<boolean> {
  if (!shuttingDown) {
    shuttingDown = true;
    logger.info(
      { in_flight: inFlightCount, timeout_ms: timeoutMs },
      'Shutdown initiated, waiting for in-flight requests to drain'
    );
  }

  if (inFlightCount === 0) {
    logger.info('No in-flight requests, drain complete');
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const idx = drainResolvers.indexOf(drainResolver);
      if (idx !== -1) {
        drainResolvers.splice(idx, 1);
      }

      logger.warn(
        { in_flight: inFlightCount, timeout_ms: timeoutMs },
        'Drain timed out, forcing shutdown'
      );
      resolve(false);
    }, timeoutMs);

    const drainResolver = {
      resolve: () => {
        clearTimeout(timer);
        logger.info('All in-flight requests drained');
        resolve(true);
      },
    };

    drainResolvers.push(drainResolver);
  });
}

/**
 * Initiate graceful shutdown: mark as shutting down and wait for drain.
 * @param server - Optional Bun.serve server instance for verification
 * @returns true if graceful shutdown completed, false if forced
 */
export async function initiateGracefulShutdown(
  server?: { pendingRequests: number } | null
): Promise<boolean> {
  logger.info('Initiating graceful shutdown');

  const drained = await waitForDrain();

  if (!drained && server && typeof server.pendingRequests === 'number') {
    logger.warn(
      { pending_requests: server.pendingRequests },
      'Bun server pending requests at force-shutdown'
    );
  }

  return drained;
}

/**
 * Reset shutdown state (for testing only).
 * @internal
 */
export function resetShutdownState(): void {
  inFlightCount = 0;
  shuttingDown = false;
  drainResolvers.length = 0;
}
