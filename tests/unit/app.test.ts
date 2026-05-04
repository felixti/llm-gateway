import { describe, expect, test } from 'bun:test';
import { createApp } from '../../src/app';
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
});
