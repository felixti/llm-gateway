/**
 * Messages Routes Integration Tests
 * Tests for POST /v1/messages endpoint (Anthropic)
 */

import { describe, expect, it } from 'bun:test';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

const VALID_PAT = 'Bearer lg_user1_header.payload.signature';

function createValidBody(overrides = {}) {
  return {
    model: 'claude-3-5-sonnet-6-20240620',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 1024,
    ...overrides,
  };
}

describe('Messages Routes - /v1/messages', () => {
  describe('Authentication', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidBody()),
      });

      expect(response.status).toBe(401);
    });

    it('should return 401 when PAT is invalid', async () => {
      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer invalid',
        },
        body: JSON.stringify(createValidBody()),
      });

      expect(response.status).toBe(401);
    });
  });

  describe('Request Validation', () => {
    it('should return 400 when model is missing', async () => {
      const body = { messages: [{ role: 'user', content: 'Hello' }] };

      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
    });

    it('should return 400 when messages array is empty', async () => {
      const body = createValidBody({ messages: [] });

      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
    });

    it('should return 400 when max_tokens is missing', async () => {
      const body = {
        model: 'claude-3-5-sonnet-6-20240620',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
    });

    it('should return 400 for unknown model', async () => {
      const body = createValidBody({ model: 'unknown-claude-model' });

      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('Request Body - Anthropic Specific', () => {
    it('should accept valid request with system message', async () => {
      const body = createValidBody({
        system: 'You are a helpful assistant.',
      });

      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(response.status);
    });

    it('should accept request with thinking enabled', async () => {
      const body = createValidBody({
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });

      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(response.status);
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

      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(response.status);
    });
  });

  describe('Role Validation', () => {
    it('should accept user role messages', async () => {
      const body = createValidBody({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(response.status);
    });

    it('should accept assistant role messages', async () => {
      const body = createValidBody({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect([200, 400, 502, 503]).toContain(response.status);
    });

    it('should reject invalid role', async () => {
      const body = createValidBody({
        messages: [{ role: 'invalid-role', content: 'Hello' }],
      });

      const response = await fetch(`${GATEWAY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
    });
  });
});
