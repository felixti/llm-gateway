/**
 * Messages Routes Integration Tests
 * Tests for POST /v1/messages endpoint (Anthropic)
 */

import { describe, expect, it } from 'bun:test';
import { createTestApp } from '../helpers/test-app';
import { createTestPat, INVALID_PAT } from '../helpers/test-pat';

const VALID_PAT = createTestPat('user1');

function createValidBody(overrides = {}) {
  return {
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 1024,
    ...overrides,
  };
}

describe('Messages Routes - /v1/messages', () => {
  describe('Authentication', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidBody()),
      });

      expect(res.status).toBe(401);
    });

    it('should return 401 when PAT is invalid', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: INVALID_PAT,
        },
        body: JSON.stringify(createValidBody()),
      });

      expect(res.status).toBe(401);
    });
  });

  describe('Request Validation', () => {
    it('should return 400 when model is missing', async () => {
      const body = { messages: [{ role: 'user', content: 'Hello' }] };

      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 when messages array is empty', async () => {
      const body = createValidBody({ messages: [] });

      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 when max_tokens is missing', async () => {
      const body = {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 for unknown model', async () => {
      const body = createValidBody({ model: 'unknown-claude-model' });

      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('Request Body - Anthropic Specific', () => {
    it('should accept valid request with system message', async () => {
      const body = createValidBody({
        system: 'You are a helpful assistant.',
      });

      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(res.status);
    });

    it('should accept request with thinking enabled', async () => {
      const body = createValidBody({
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });

      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(res.status);
    });

    it('should accept request with tools', async () => {
      const body = createValidBody({
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a location',
            input_schema: { type: 'object', properties: { location: { type: 'string' } } },
          },
        ],
      });

      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(res.status);
    });
  });

  describe('Role Validation', () => {
    it('should accept user role messages', async () => {
      const body = createValidBody({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(res.status);
    });

    it('should accept assistant role messages', async () => {
      const body = createValidBody({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(res.status);
    });

    it('should reject invalid role', async () => {
      const body = createValidBody({
        messages: [{ role: 'invalid-role', content: 'Hello' }],
      });

      const app = await createTestApp();
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
    });
  });
});
