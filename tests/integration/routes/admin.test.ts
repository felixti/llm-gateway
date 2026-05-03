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
const OPERATOR_SECRET = 'test-operator-secret-32chars!!';

let originalExecute: typeof database.execute;
const originalOperatorSecret = process.env.ADMIN_OPERATOR_SECRET;

describe('Admin Routes - /admin', () => {
  beforeEach(() => {
    process.env.ADMIN_OPERATOR_SECRET = OPERATOR_SECRET;
    originalExecute = database.execute.bind(database);
    database.execute = async () => ({ rows: [], rowCount: 0 });
  });

  afterEach(() => {
    database.execute = originalExecute;
    if (originalOperatorSecret === undefined) {
      delete process.env.ADMIN_OPERATOR_SECRET;
    } else {
      process.env.ADMIN_OPERATOR_SECRET = originalOperatorSecret;
    }
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
          'X-Operator-Secret': OPERATOR_SECRET,
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
          'X-Operator-Secret': OPERATOR_SECRET,
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
          'X-Operator-Secret': OPERATOR_SECRET,
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
          'X-Operator-Secret': OPERATOR_SECRET,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('should return 400 for empty pat_id', async () => {
      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
          'X-Operator-Secret': OPERATOR_SECRET,
        },
        body: JSON.stringify({ pat_id: '' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });
  });

  describe('Success', () => {
    it('should revoke PAT with valid request', async () => {
      database.execute = async <T extends Record<string, unknown>>({ query }: { query: string }) => {
        if (String(query).includes('api_keys')) {
          return {
            rows: [{ id: 'key-1', jti: '11111111-1111-1111-1111-111111111111' } as unknown as T],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      };

      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
          'X-Operator-Secret': OPERATOR_SECRET,
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
      database.execute = async <T extends Record<string, unknown>>({ query }: { query: string }) => {
        if (String(query).includes('api_keys')) {
          return {
            rows: [{ id: 'key-2', jti: '22222222-2222-2222-2222-222222222222' } as unknown as T],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      };

      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
          'X-Operator-Secret': OPERATOR_SECRET,
        },
        body: JSON.stringify({
          pat_id: '22222222-2222-2222-2222-222222222222',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('should set blocklist entry without TTL', async () => {
      const setCalls: unknown[][] = [];
      const { redis } = await import('../../../src/db/redis');
      const originalSet = redis.set.bind(redis);
      database.execute = async <T extends Record<string, unknown>>({ query }: { query: string }) => {
        const q = String(query);
        if (q.includes('api_keys')) {
          return {
            rows: [{ id: 'key-3', jti: '33333333-3333-3333-3333-333333333333' } as unknown as T],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      };

      try {
        const app = await createTestApp();
        redis.set = (async (...args: unknown[]) => {
          setCalls.push(args);
          return 'OK';
        }) as typeof redis.set;
        const res = await app.request('/admin/pat/revoke', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: ADMIN_PAT,
            'X-Operator-Secret': OPERATOR_SECRET,
          },
          body: JSON.stringify({
            pat_id: '33333333-3333-3333-3333-333333333333',
          }),
        });

        expect(res.status).toBe(200);
        expect(setCalls.length).toBeGreaterThan(0);
        expect(setCalls[0]).toHaveLength(2);
        expect(setCalls[0][0]).toContain('blocklist:pat:');
        expect(setCalls[0][1]).toBe('1');
      } finally {
        redis.set = originalSet;
      }
    });

    it('should return 404 for non-existent PAT', async () => {
      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
          'X-Operator-Secret': OPERATOR_SECRET,
        },
        body: JSON.stringify({
          pat_id: '44444444-4444-4444-4444-444444444444',
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    });

    it('returns 500 when DB error occurs during PAT lookup', async () => {
      database.execute = async () => {
        throw new Error('connection refused');
      };

      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
          'X-Operator-Secret': OPERATOR_SECRET,
        },
        body: JSON.stringify({
          pat_id: '55555555-5555-5555-5555-555555555555',
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('internal_error');
    });

    it('revokes PAT by id::text and blocklists using the actual token jti', async () => {
      const patId = '66666666-6666-6666-6666-666666666666';
      const actualJti = 'different-jti-value';
      const setCalls: unknown[][] = [];
      const { redis } = await import('../../../src/db/redis');
      const originalSet = redis.set.bind(redis);
      database.execute = async <T extends Record<string, unknown>>({ query }: { query: string }) => {
        const q = String(query);
        if (q.includes('api_keys')) {
          return {
            rows: [{ id: patId, jti: actualJti } as unknown as T],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      };

      try {
        const app = await createTestApp();
        redis.set = (async (...args: unknown[]) => {
          setCalls.push(args);
          return 'OK';
        }) as typeof redis.set;
        const res = await app.request('/admin/pat/revoke', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: ADMIN_PAT,
            'X-Operator-Secret': OPERATOR_SECRET,
          },
          body: JSON.stringify({ pat_id: patId }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { success: boolean; pat_id: string };
        expect(body.success).toBe(true);
        expect(body.pat_id).toBe(patId);

        expect(setCalls.length).toBeGreaterThan(0);
        const blocklistKey = setCalls[0][0] as string;
        expect(blocklistKey).toContain('blocklist:pat:');
        const expectedHash = (await import('../../../src/utils/auth')).hashJtiForBlocklist(actualJti);
        expect(blocklistKey).toBe(`blocklist:pat:${expectedHash}`);
      } finally {
        redis.set = originalSet;
      }
    });

    it('revokes PAT with non-UUID jti', async () => {
      const nonUuidJti = 'my-custom-jti-12345';
      database.execute = async <T extends Record<string, unknown>>({ query }: { query: string }) => {
        const q = String(query);
        if (q.includes('api_keys')) {
          return {
            rows: [{ id: 'key-7', jti: nonUuidJti } as unknown as T],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      };

      const app = await createTestApp();
      const res = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
          'X-Operator-Secret': OPERATOR_SECRET,
        },
        body: JSON.stringify({ pat_id: nonUuidJti }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; pat_id: string };
      expect(body.success).toBe(true);
      expect(body.pat_id).toBe(nonUuidJti);
    });

    it('blocks revoked PAT token via auth middleware', async () => {
      const revokedJti = 'revoked-jti-abc123';
      const revokedPat = createTestPat('user1', { jti: revokedJti, scope: 'all' });
      database.execute = async <T extends Record<string, unknown>>({ query }: { query: string }) => {
        const q = String(query);
        if (q.includes('api_keys')) {
          return {
            rows: [{ id: 'key-8', jti: revokedJti } as unknown as T],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      };

      const app = await createTestApp();

      const revokeRes = await app.request('/admin/pat/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: ADMIN_PAT,
          'X-Operator-Secret': OPERATOR_SECRET,
        },
        body: JSON.stringify({ pat_id: revokedJti }),
      });
      expect(revokeRes.status).toBe(200);

      const protectedRes = await app.request('/v1/models', {
        headers: {
          Authorization: revokedPat,
        },
      });
      expect(protectedRes.status).toBe(401);
      const protectedBody = (await protectedRes.json()) as { error: { code: string; message: string } };
      expect(protectedBody.error.code).toBe('authentication_error');
      expect(protectedBody.error.message).toBe('Token has been revoked');
    });
  });
});
