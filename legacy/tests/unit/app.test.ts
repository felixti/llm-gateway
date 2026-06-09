import { describe, expect, test } from 'bun:test';
import { createApp, shouldCompressResponse } from '../../src/app';
import { startServer } from '../../src/index';

describe('createApp', () => {
  test('creates a fetchable Hono app without starting a Bun server', async () => {
    const app = createApp();

    const res = await app.request('/health');

    expect(res.status).toBe(200);
  });

  test('can import the runtime entrypoint without starting the server', () => {
    expect(startServer).toBeTypeOf('function');
  });

  test('does not compress server-sent event responses', () => {
    const res = new Response('data: {}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });

    expect(shouldCompressResponse(res)).toBe(false);
  });

  test('does not compress responses that opt out of transformation', () => {
    const res = new Response('streaming payload', {
      headers: { 'Cache-Control': 'no-cache, no-transform' },
    });

    expect(shouldCompressResponse(res)).toBe(false);
  });
});
