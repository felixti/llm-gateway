import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  resetShutdownState,
  shutdownMiddleware,
  waitForDrain,
  initiateGracefulShutdown,
  getInFlightCount,
  isShuttingDown,
} from '@/services/shutdown.service';
import { Hono } from 'hono';

describe('shutdown.service - extended coverage', () => {
  beforeEach(() => {
    resetShutdownState();
  });

  afterEach(() => {
    resetShutdownState();
  });

  describe('initiateGracefulShutdown', () => {
    it('returns true when no in-flight requests', async () => {
      const result = await initiateGracefulShutdown();
      expect(result).toBe(true);
    });

    it('returns true with server when drained successfully', async () => {
      const server = { pendingRequests: 0 };
      const result = await initiateGracefulShutdown(server);
      expect(result).toBe(true);
    });

    it('returns false when drain times out with in-flight requests', async () => {
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
      expect(getInFlightCount()).toBe(1);

      const result = await waitForDrain(50);
      expect(result).toBe(false);

      closeStream?.();
      await response.arrayBuffer();
      resetShutdownState();
    });
  });

  describe('shutdownMiddleware - 503 rejection', () => {
    it('rejects new requests with 503 during shutdown', async () => {
      const app = new Hono();
      app.use('*', shutdownMiddleware);
      app.get('/test', (c) => c.json({ ok: true }));

      await waitForDrain(10);

      const res = await app.request('/test');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe('shutting_down');
    });
  });

  describe('waitForDrain', () => {
    it('returns true immediately when no in-flight requests', async () => {
      const result = await waitForDrain(100);
      expect(result).toBe(true);
    });

    it('returns true when draining a streaming response that closes', async () => {
      const app = new Hono();
      let closeStream: (() => void) | undefined;

      app.use('*', shutdownMiddleware);
      app.get('/stream', () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
            closeStream = () => controller.close();
          },
        });
        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });

      const response = await app.request('/stream');
      expect(getInFlightCount()).toBe(1);

      const drainPromise = waitForDrain(5000);

      closeStream?.();
      await response.arrayBuffer();

      const result = await drainPromise;
      expect(result).toBe(true);
      expect(getInFlightCount()).toBe(0);
    });
  });

  describe('isShuttingDown', () => {
    it('returns false before shutdown', () => {
      expect(isShuttingDown()).toBe(false);
    });

    it('returns true after waitForDrain is called', async () => {
      await waitForDrain(10);
      expect(isShuttingDown()).toBe(true);
    });
  });
});
