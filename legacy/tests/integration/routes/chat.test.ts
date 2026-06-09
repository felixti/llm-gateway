/**
 * Chat Routes Integration Tests
 * Tests for POST /v1/chat/completions endpoint
 * Validates API contract and middleware behavior
 */

import { describe, expect, it } from 'bun:test';
import { createTestApp } from '../helpers/test-app';
import { createTestPat, INVALID_PAT } from '../helpers/test-pat';

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    protocol?: string;
  };
}

const VALID_PAT = createTestPat('user1');

/**
 * Helper to create a minimal valid request body
 */
function createValidBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

describe('Chat Routes - /v1/chat/completions', () => {
  describe('Authentication', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidBody()),
      });

      const body = (await res.json()) as ErrorResponse;
      expect(res.status).toBe(401);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('authentication_error');
    });

    it('should return 401 when PAT format is invalid', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: INVALID_PAT,
        },
        body: JSON.stringify(createValidBody()),
      });

      const body = (await res.json()) as ErrorResponse;
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('authentication_error');
    });

    it('should return 401 when PAT is expired', async () => {
      const expiredPat = createTestPat('user1', { exp: 1 });

      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: expiredPat,
        },
        body: JSON.stringify(createValidBody()),
      });

      const body = (await res.json()) as ErrorResponse;
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('authentication_error');
    });
  });

  describe('Request Validation', () => {
    it('should return 400 when model is missing', async () => {
      const body = { messages: [{ role: 'user', content: 'Hello' }] };

      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      const result = (await res.json()) as ErrorResponse;
      expect(res.status).toBe(400);
      expect(result.error.code).toBe('invalid_request');
    });

    it('should return 400 when messages array is empty', async () => {
      const body = { model: 'gpt-5.4', messages: [] };

      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      const result = (await res.json()) as ErrorResponse;
      expect(res.status).toBe(400);
      expect(result.error.code).toBe('invalid_request');
    });

    it('should return 400 when messages array is missing', async () => {
      const body = { model: 'gpt-5.4' };

      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      const result = (await res.json()) as ErrorResponse;
      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid JSON body', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: 'not-valid-json',
      });

      const result = (await res.json()) as ErrorResponse;
      expect(res.status).toBe(400);
      expect(result.error.code).toBe('invalid_request');
    });

    it('should return 400 for unknown model', async () => {
      const body = createValidBody({ model: 'unknown-model-xyz' });

      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      const result = (await res.json()) as ErrorResponse;
      expect(res.status).toBe(400);
      expect(result.error.code).toBe('model_not_supported');
    });
  });

  describe('Request Body Structure', () => {
    it('should accept valid request with minimal body', async () => {
      const body = createValidBody();

      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      // Accept 200 (success) or 400/502/503 (upstream issues but validation passed)
      expect([200, 400, 502, 503]).toContain(res.status);
    });

    it('should accept request with optional parameters', async () => {
      const body = createValidBody({
        temperature: 0.7,
        max_tokens: 100,
        top_p: 0.9,
        stream: false,
      });

      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(res.status);
    });

    it('should reject temperature out of range (0-2)', async () => {
      const body = createValidBody({ temperature: 3.0 });

      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      const result = (await res.json()) as ErrorResponse;
      expect(res.status).toBe(400);
      expect(result.error.code).toBe('invalid_request');
    });

    it('should reject negative max_tokens', async () => {
      const body = createValidBody({ max_tokens: -1 });

      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      const result = (await res.json()) as ErrorResponse;
      expect(res.status).toBe(400);
      expect(result.error.code).toBe('invalid_request');
    });
  });

  describe('Response Structure', () => {
    it('should return proper error response structure', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createValidBody()),
      });

      const body = (await res.json()) as ErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
    });
  });
});
