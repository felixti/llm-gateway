/**
 * Models Routes Integration Tests
 * Tests for GET /v1/models endpoint
 */

import { describe, expect, it } from 'bun:test';
import { createTestApp } from '../helpers/test-app';
import { createTestPat, INVALID_PAT } from '../helpers/test-pat';

const VALID_PAT = createTestPat('user1');

describe('Models Routes - /v1/models', () => {
  describe('Authentication', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/models');
      const body = (await res.json()) as { error: { code: string } };
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('authentication_error');
    });

    it('should return 401 when PAT format is invalid', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/models', {
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
      const res = await app.request('/v1/models', {
        headers: { Authorization: writePat },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('permission_error');
    });
  });

  describe('Success', () => {
    it('should return list of models with valid PAT', async () => {
      const app = await createTestApp();
      const res = await app.request('/v1/models', {
        headers: { Authorization: VALID_PAT },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        object: string;
        data: Array<{
          id: string;
          object: string;
          owned_by: string;
          gateway: Record<string, unknown>;
        }>;
      };
      expect(body.object).toBe('list');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0].object).toBe('model');
      expect(body.data[0].gateway).toBeDefined();
    });

    it('should allow read-scope PAT', async () => {
      const app = await createTestApp();
      const readPat = createTestPat('user1', { scope: 'read' });
      const res = await app.request('/v1/models', {
        headers: { Authorization: readPat },
      });
      expect(res.status).toBe(200);
    });

    it('should not serve an all-scope cached model list to a restricted scope', async () => {
      const app = await createTestApp();

      const allRes = await app.request('/v1/models', {
        headers: { Authorization: createTestPat('user1', { scope: 'all' }) },
      });
      expect(allRes.status).toBe(200);
      const allBody = (await allRes.json()) as { data: unknown[] };
      expect(allBody.data.length).toBeGreaterThan(0);

      const readRes = await app.request('/v1/models', {
        headers: { Authorization: createTestPat('user1', { scope: 'read' }) },
      });
      expect(readRes.status).toBe(200);
      const readBody = (await readRes.json()) as { data: unknown[] };
      expect(readBody.data.length).toBe(0);
    });
  });
});
