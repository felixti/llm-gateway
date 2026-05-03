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
        hard_limit: boolean;
      };
      expect(body.monthly_budget_usd).toBeDefined();
      expect(body.spent_usd).toBeDefined();
      expect(body.reserved_usd).toBeDefined();
      expect(body.remaining_usd).toBeDefined();
      expect(body.reset_date).toBeDefined();
      expect(body.hard_limit).toBeDefined();
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

  describe('Degraded dependencies', () => {
    /**
     * With `getQuotaStatus()` hardened to fail-closed on Redis read failures,
     * the GET /quota endpoint must return 429 with a structured error — never
     * 500 — so clients know quota status is temporarily unavailable and can
     * retry or fall back gracefully.
     */
    it('returns 429 with quota_unavailable when quota-key Redis reads reject', async () => {
      const app = await createTestApp();
      const { redis } = await import('@/db/redis');
      const r = redis as unknown as Record<
        string,
        (key: string, ...rest: unknown[]) => Promise<unknown>
      >;
      const originalHget = r.hget;
      const originalGet = r.get;

      // Only fail reads that target quota keys. Blocklist keys used by the
      // auth middleware must keep working so the request can reach /quota.
      r.hget = async (key: string, ...rest: unknown[]) => {
        if (key.startsWith('quota:')) {
          throw new Error('redis quota partition unreachable');
        }
        return originalHget.call(redis, key, ...rest);
      };
      r.get = async (key: string, ...rest: unknown[]) => {
        if (key.startsWith('reserved:')) {
          throw new Error('redis reserved partition unreachable');
        }
        return originalGet.call(redis, key, ...rest);
      };

      try {
        const res = await app.request('/quota', {
          headers: { Authorization: VALID_PAT },
        });
        expect(res.status).toBe(429);
        const body = (await res.json()) as {
          error: { code: string; message: string };
        };
        expect(body.error.code).toBe('quota_unavailable');
      } finally {
        r.hget = originalHget;
        r.get = originalGet;
      }
    });
  });
});
