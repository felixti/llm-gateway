/**
 * Tests for the timeout middleware — signal plumbing and 504 behavior.
 *
 * We exercise the middleware against a minimal Hono app so the AbortSignal
 * is set on the real request context. The tests rely on a short
 * REQUEST_TIMEOUT_MS value set via the test env (default 30s is fine for
 * the 504 test because we use a very short override).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { REQUEST_SIGNAL_KEY, timeoutMiddleware } from '../../../src/middleware/timeout';
import { resetEnvForTests } from '../../../src/config/env';

describe('timeoutMiddleware', () => {
  const originalTimeout = process.env.REQUEST_TIMEOUT_MS;

  beforeEach(() => {
    resetEnvForTests();
  });

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.REQUEST_TIMEOUT_MS;
    } else {
      process.env.REQUEST_TIMEOUT_MS = originalTimeout;
    }
    resetEnvForTests();
  });

  test('exposes a non-aborted AbortSignal on the context for fast handlers', async () => {
    process.env.REQUEST_TIMEOUT_MS = '5000';
    resetEnvForTests();

    const app = new Hono();
    let observedSignal: AbortSignal | undefined;
    app.use('*', timeoutMiddleware);
    app.get('/probe', (c) => {
      observedSignal = c.get(REQUEST_SIGNAL_KEY) as AbortSignal;
      return c.json({ ok: true });
    });

    const res = await app.request('/probe');

    expect(res.status).toBe(200);
    expect(observedSignal).toBeDefined();
    expect(observedSignal!.aborted).toBe(false);
  });

  test('returns 504 and aborts the context signal when the handler exceeds the budget', async () => {
    process.env.REQUEST_TIMEOUT_MS = '25';
    resetEnvForTests();

    const app = new Hono();
    let observedSignal: AbortSignal | undefined;
    app.use('*', timeoutMiddleware);
    app.get('/slow', async (c) => {
      observedSignal = c.get(REQUEST_SIGNAL_KEY) as AbortSignal;
      // Resolve after the timeout budget so the race resolves on timeout.
      await new Promise((r) => setTimeout(r, 200));
      return c.json({ ok: true });
    });

    const res = await app.request('/slow');

    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('gateway_timeout');
    expect(body.error.message).toMatch(/timeout/i);
    // By the time the timeout fires, the signal the handler captured must
    // be aborted so any upstream fetch using it would be cancelled.
    expect(observedSignal?.aborted).toBe(true);
  });

  test('forwards an already-aborted upstream signal through to the context signal', async () => {
    process.env.REQUEST_TIMEOUT_MS = '5000';
    resetEnvForTests();

    const app = new Hono();
    let observedSignal: AbortSignal | undefined;
    app.use('*', timeoutMiddleware);
    app.get('/abort', (c) => {
      observedSignal = c.get(REQUEST_SIGNAL_KEY) as AbortSignal;
      return c.json({ ok: true });
    });

    const controller = new AbortController();
    controller.abort(new Error('client gone'));

    await app.request('/abort', { signal: controller.signal });

    expect(observedSignal?.aborted).toBe(true);
  });

  test('keeps forwarding client aborts after a streaming response is returned', async () => {
    process.env.REQUEST_TIMEOUT_MS = '5000';
    resetEnvForTests();

    const app = new Hono();
    let observedSignal: AbortSignal | undefined;
    app.use('*', timeoutMiddleware);
    app.get('/stream', (c) => {
      observedSignal = c.get(REQUEST_SIGNAL_KEY) as AbortSignal;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
        },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const controller = new AbortController();
    const res = await app.request('/stream', { signal: controller.signal });

    expect(res.status).toBe(200);
    expect(observedSignal?.aborted).toBe(false);

    controller.abort(new Error('client disconnected'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observedSignal?.aborted).toBe(true);
  });
});
