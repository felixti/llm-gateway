/**
 * Quota Routes Integration Tests
 * Tests for GET /quota endpoint
 */

import { describe, expect, it } from 'bun:test';
import { createTestApp } from '../helpers/test-app';
import { createTestPat, INVALID_PAT } from '../helpers/test-pat';

const VALID_PAT = createTestPat('user1');

describe('Quota Routes - /quota', () => {
  describe('Authentication', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const app = await createTestApp();
      const res = await app.request('/quota');
      const body = (await res.json()) as { error: { code: string } };
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('authentication_error');
    });

    it('should return 401 when PAT format is invalid', async () => {
      const app = await createTestApp();
      const res = await app.request('/quota', {
        headers: { Authorization: INVALID_PAT },
      });
      const body = (await res.json()) as { error: { code: string } };
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('authentication_error');
    });
  });

  describe('Authorization', () => {
    it('should return 403 for write-only PAT on GET', async () => {
      const app = await createTestApp();
      const writePat = createTestPat('user1', { scope: 'write' });
      const res = await app.request('/quota', {
        headers: { Authorization: writePat },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('permission_error');
    });
  });

  describe('Success', () => {
    it('should return quota status with valid PAT', async () => {
      const app = await createTestApp();
      const res = await app.request('/quota', {
        headers: { Authorization: VALID_PAT },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        monthly_budget_usd: number;
        spent_usd: number;
        reserved_usd: number;
        remaining_usd: number;
        reset_date: string;
      };
      expect(body.monthly_budget_usd).toBeDefined();
      expect(body.spent_usd).toBeDefined();
      expect(body.reserved_usd).toBeDefined();
      expect(body.remaining_usd).toBeDefined();
      expect(body.reset_date).toBeDefined();
    });

    it('should allow read-scope PAT', async () => {
      const app = await createTestApp();
      const readPat = createTestPat('user1', { scope: 'read' });
      const res = await app.request('/quota', {
        headers: { Authorization: readPat },
      });
      expect(res.status).toBe(200);
    });
  });
});
