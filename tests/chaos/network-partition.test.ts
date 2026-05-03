/**
 * Chaos: Network Partition simulation.
 *
 * Simulates network partition between the gateway and its backing services
 * (Redis, Postgres) by patching client methods to throw connection errors.
 * Asserts the gateway degrades gracefully (no unhandled rejections) and
 * returns appropriate error codes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestApp } from '../integration/helpers/test-app';
import { createTestPat } from '../integration/helpers/test-pat';
import { redis } from '../../src/db/redis';
import database from '../../src/db/client';

const VALID_PAT = createTestPat('user1');

const CHAT_BODY = JSON.stringify({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'test' }],
});

interface Patch {
  target: Record<string, unknown>;
  key: string;
  original: unknown;
}

const patches: Patch[] = [];

function patch(target: Record<string, unknown>, key: string, replacement: unknown): void {
  patches.push({ target, key, original: target[key] });
  target[key] = replacement;
}

function restoreAll(): void {
  while (patches.length > 0) {
    const p = patches.pop();
    if (!p) continue;
    p.target[p.key] = p.original;
  }
}

function asyncConnectionRefused(): Promise<never> {
  return Promise.reject(new Error('ECONNREFUSED'));
}

describe('Chaos: Network Partition', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    restoreAll();
  });

  it('should return 503 when Redis is partitioned during auth blocklist check', async () => {
    const app = await createTestApp();

    const r = redis as unknown as Record<string, unknown>;
    patch(r, 'get', asyncConnectionRefused);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: VALID_PAT,
      },
      body: CHAT_BODY,
    });

    expect(res.status).toBe(503);
    const body = await res.json() as { error?: { code: string }; code?: string };
    expect(body.error?.code ?? body.code).toBe('service_unavailable');
  });

  it('should degrade when Redis EVAL (rate-limit + quota) fails', async () => {
    const app = await createTestApp();

    const r = redis as unknown as Record<string, unknown>;
    patch(r, 'eval', asyncConnectionRefused);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: VALID_PAT,
      },
      body: CHAT_BODY,
    });

    expect([200, 429, 500, 503]).toContain(res.status);
  });

  it('should degrade gracefully when Postgres is partitioned', async () => {
    const app = await createTestApp();

    const db = database as unknown as Record<string, unknown>;
    patch(db, 'execute', async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:5432');
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: VALID_PAT,
      },
      body: CHAT_BODY,
    });

    expect([200, 429, 503]).toContain(res.status);
  });

  it('should degrade gracefully when both Redis and Postgres are partitioned', async () => {
    const app = await createTestApp();

    const r = redis as unknown as Record<string, unknown>;
    patch(r, 'eval', asyncConnectionRefused);

    const db = database as unknown as Record<string, unknown>;
    patch(db, 'execute', async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:5432');
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: VALID_PAT,
      },
      body: CHAT_BODY,
    });

    expect([200, 429, 500, 503]).toContain(res.status);
  });
});
