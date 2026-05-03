/**
 * Responses Routes Integration Tests
 * Tests for POST /v1/responses endpoint
 */

import { describe, expect, it } from 'bun:test';
import { createTestApp } from '../helpers/test-app';
import { createTestPat, INVALID_PAT } from '../helpers/test-pat';

const VALID_PAT = createTestPat('user1');

function createValidBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-5.4',
    input: 'Hello',
    ...overrides,
  };
}

describe('Responses Routes - /v1/responses', () => {
  describe('Authentication', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidBody()),
      });
      const body = (await res.json()) as { error: { code: string } };
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('authentication_error');
    });

    it('should return 401 when PAT format is invalid', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: INVALID_PAT,
        },
        body: JSON.stringify(createValidBody()),
      });
      const body = (await res.json()) as { error: { code: string } };
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('authentication_error');
    });
  });

  describe('Authorization', () => {
    it('should return 403 for read-only PAT on POST', async () => {
      const app = await createTestApp();
      const readPat = createTestPat('user1', { scope: 'read' });
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: readPat,
        },
        body: JSON.stringify(createValidBody()),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('permission_error');
    });
  });

  describe('Validation', () => {
    it('should return 400 for invalid JSON body', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('should return 400 for missing model', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify({ input: 'Hello' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('should return 400 for unsupported model family', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify({ model: 'claude-opus-4-6', input: 'Hello' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('model_not_supported');
    });
  });

  describe('Success', () => {
    it('should return 200 for valid non-streaming request', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(createValidBody({ stream: false })),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; output: unknown[] };
      expect(body.id).toBeDefined();
      expect(Array.isArray(body.output)).toBe(true);
    });

    it('should accept array input format', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify({
          model: 'gpt-5.4',
          input: [{ role: 'user', content: 'Hello' }],
          stream: false,
        }),
      });
      expect(res.status).toBe(200);
    });

    it('should accept tools in request body', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify({
          model: 'gpt-5.4',
          input: 'Hello',
          stream: false,
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              description: 'Get weather info',
              parameters: { type: 'object', properties: {} },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
    });
  });
});
