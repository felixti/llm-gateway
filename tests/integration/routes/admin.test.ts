/**
 * Admin Routes Integration Tests
 * Tests for POST /admin/pat/revoke endpoint
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { createTestApp } from '../helpers/test-app';
import { createTestPat, INVALID_PAT } from '../helpers/test-pat';
import { database } from '../../../src/db/client';

const VALID_PAT = createTestPat('user1');
const ADMIN_PAT = createTestPat('user1', { scope: 'admin' });

let originalExecute: typeof database.execute;

describe('Admin Routes - /admin', () => {
  beforeEach(() => {
    originalExecute = database.execute.bind(database);
    database.execute = async () => ({ rows: [], rowCount: 0 });
  });

  afterEach(() => {
    database.execute = originalExecute;
  });

  describe('Authentication', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pat_id: '11111111-1111-1111-1111-111111111111' }),
      });
      const body = (await res.json()) as { error: { code: string } };
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('authentication_error');
    });

    it('should return 401 when PAT format is invalid', async () => {
      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: INVALID_PAT,
        },
        body: JSON.stringify({ pat_id: '11111111-1111-1111-1111-111111111111' }),
      });
      const body = (await res.json()) as { error: { code: string } };
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('authentication_error');
    });
  });

  describe('Authorization', () => {
    it('should return 403 when PAT scope is all (operator route)', async () => {
      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: VALID_PAT,
        },
        body: JSON.stringify({ pat_id: '11111111-1111-1111-1111-111111111111' }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('permission_error');
    });

    it('should return 403 for read-only PAT on POST', async () => {
      const app = await createTestApp();
      const readPat = createTestPat('user1', { scope: 'read' });
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: readPat,
        },
        body: JSON.stringify({ pat_id: '11111111-1111-1111-1111-111111111111' }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('permission_error');
    });
  });

  describe('Validation', () => {
    it('should return 400 for invalid JSON body', async () => {
      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
        },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('should return 400 for missing pat_id', async () => {
      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('should return 400 for invalid UUID pat_id', async () => {
      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
        },
        body: JSON.stringify({ pat_id: 'not-a-uuid' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });
  });

  describe('Success', () => {
    it('should revoke PAT with valid request', async () => {
      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
        },
        body: JSON.stringify({
          pat_id: '11111111-1111-1111-1111-111111111111',
          reason: 'Test revocation',
        }),
      });
      // 200 because Redis blocklist succeeds even if PostgreSQL logging fails
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; pat_id: string };
      expect(body.success).toBe(true);
      expect(body.pat_id).toBe('11111111-1111-1111-1111-111111111111');
    });

    it('should revoke PAT without reason', async () => {
      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
        },
        body: JSON.stringify({
          pat_id: '22222222-2222-2222-2222-222222222222',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });
  });
});
