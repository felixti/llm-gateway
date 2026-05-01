import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  getInFlightCount,
  resetShutdownState,
  shutdownMiddleware,
  waitForDrain,
} from '@/services/shutdown.service';

describe('shutdownMiddleware', () => {
  it('keeps streaming responses in-flight until the response body closes', async () => {
    resetShutdownState();
    const app = new Hono();
    let closeStream: (() => void) | undefined;

    app.use('*', shutdownMiddleware);
    app.get('/stream', () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: first\n\n'));
          closeStream = () => controller.close();
        },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const response = await app.request('/stream');
    expect(response.status).toBe(200);
    expect(getInFlightCount()).toBe(1);

    const drainBeforeClose = await waitForDrain(10);
    expect(drainBeforeClose).toBe(false);
    expect(getInFlightCount()).toBe(1);

    closeStream?.();
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getInFlightCount()).toBe(0);
    resetShutdownState();
  });
});
