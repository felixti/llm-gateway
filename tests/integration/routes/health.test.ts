/**
 * Health Routes Integration Tests
 * Tests for GET /health and GET /ready endpoints
 */

import { describe, expect, it } from 'bun:test';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

interface HealthResponse {
  version: string;
  timestamp: string;
}

interface ReadyResponse {
  status: 'ready' | 'not_ready';
  checks: {
    redis: boolean;
    deployments: boolean;
  };
  timestamp: string;
}

describe('Health Routes', () => {
  describe('GET /health', () => {
    it('should return 200 with version and timestamp', async () => {
      const response = await fetch(`${GATEWAY_URL}/health`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as HealthResponse;
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('timestamp');
      expect(typeof body.version).toBe('string');
      expect(typeof body.timestamp).toBe('string');
    });

    it('should return valid ISO timestamp', async () => {
      const response = await fetch(`${GATEWAY_URL}/health`);
      const body = (await response.json()) as HealthResponse;

      const timestamp = new Date(body.timestamp);
      expect(timestamp.getTime()).not.toBeNaN();
    });
  });

  describe('GET /ready', () => {
    it('should return 200 or 503 depending on dependencies', async () => {
      const response = await fetch(`${GATEWAY_URL}/ready`);
      const body = (await response.json()) as ReadyResponse;

      // Status should be either 200 (ready) or 503 (not ready)
      expect([200, 503]).toContain(response.status);
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('checks');
      expect(body).toHaveProperty('timestamp');
    });

    it('should include redis and deployments checks', async () => {
      const response = await fetch(`${GATEWAY_URL}/ready`);
      const body = (await response.json()) as ReadyResponse;

      expect(body.checks).toHaveProperty('redis');
      expect(body.checks).toHaveProperty('deployments');
      expect(typeof body.checks.redis).toBe('boolean');
      expect(typeof body.checks.deployments).toBe('boolean');
    });

    it('should return ready status when all checks pass', async () => {
      const response = await fetch(`${GATEWAY_URL}/ready`);
      const body = (await response.json()) as ReadyResponse;

      if (response.status === 200) {
        expect(body.status).toBe('ready');
        expect(body.checks.redis).toBe(true);
        expect(body.checks.deployments).toBe(true);
      }
    });

    it('should return not_ready status when a check fails', async () => {
      const response = await fetch(`${GATEWAY_URL}/ready`);
      const body = (await response.json()) as ReadyResponse;

      if (response.status === 503) {
        expect(body.status).toBe('not_ready');
      }
    });
  });
});
