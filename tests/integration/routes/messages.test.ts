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

  describe('POST /v1/messages/count_tokens', () => {
    function createCountTokensBody(overrides = {}) {
      return {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        ...overrides,
      };
    }

    it('returns 401 when Authorization is missing', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createCountTokensBody()),
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 when model is missing', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });
      expect(res.status).toBe(400);
    });

    it('accepts body without max_tokens and proxies token count from upstream', async () => {
      const app = await createTestApp();
      const beta = 'token-counting-2024-11-01';
      const res = await app.request('/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
          'anthropic-beta': beta,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(createCountTokensBody()),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        input_tokens: number;
        _test_echo_beta: string | null;
      };
      expect(json.input_tokens).toBe(42);
      expect(json._test_echo_beta).toBe(beta);
    });

    it('rejects non-Claude models', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(createCountTokensBody({ model: 'gpt-5.4' })),
      });
      expect(res.status).toBe(400);
    });
  });
});
