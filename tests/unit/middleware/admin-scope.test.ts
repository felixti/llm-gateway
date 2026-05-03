import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireAdminScopeMiddleware } from '../../../src/middleware/admin-scope';

function createMockContext(opts: { scope?: string; operatorSecret?: string } = {}) {
  const vars = new Map<string, unknown>();
  if (opts.scope !== undefined) {
    vars.set('scope', opts.scope);
  }
  return {
    req: {
      path: '/admin/pat/revoke',
      method: 'POST',
      header: (name: string) =>
        name.toLowerCase() === 'x-operator-secret' ? opts.operatorSecret : undefined,
    },
    get: (key: string) => vars.get(key),
    json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  } as unknown as Context;
}

const next = async () => {};

describe('requireAdminScopeMiddleware', () => {
  const originalOperatorSecret = process.env.ADMIN_OPERATOR_SECRET;

  beforeEach(() => {
    delete process.env.ADMIN_OPERATOR_SECRET;
  });

  afterEach(() => {
    if (originalOperatorSecret === undefined) {
      delete process.env.ADMIN_OPERATOR_SECRET;
    } else {
      process.env.ADMIN_OPERATOR_SECRET = originalOperatorSecret;
    }
  });

  test('secret not configured → 403 configuration_error', async () => {
    const c = createMockContext({ scope: 'admin' });
    const result = await requireAdminScopeMiddleware(c, next);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);
    const body = (await result!.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('configuration_error');
    expect(body.error.message).toContain('not configured');
  });

  test('secret too short → 403 configuration_error', async () => {
    process.env.ADMIN_OPERATOR_SECRET = 'short';
    try {
      const c = createMockContext({ scope: 'admin' });
      const result = await requireAdminScopeMiddleware(c, next);
      expect(result).toBeInstanceOf(Response);
      expect(result!.status).toBe(403);
      const body = (await result!.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('configuration_error');
    } finally {
      delete process.env.ADMIN_OPERATOR_SECRET;
    }
  });

  test('scope admin + valid secret → next()', async () => {
    process.env.ADMIN_OPERATOR_SECRET = 'super-long-operator-secret-123';
    try {
      const c = createMockContext({
        scope: 'admin',
        operatorSecret: 'super-long-operator-secret-123',
      });
      const result = await requireAdminScopeMiddleware(c, next);
      expect(result).toBeUndefined();
    } finally {
      delete process.env.ADMIN_OPERATOR_SECRET;
    }
  });

  test('scope all + valid secret → 403 permission_error', async () => {
    process.env.ADMIN_OPERATOR_SECRET = 'super-long-operator-secret-123';
    try {
      const c = createMockContext({
        scope: 'all',
        operatorSecret: 'super-long-operator-secret-123',
      });
      const result = await requireAdminScopeMiddleware(c, next);
      expect(result).toBeInstanceOf(Response);
      expect(result!.status).toBe(403);
      const body = (await result!.json()) as { error: { code: string } };
      expect(body.error.code).toBe('permission_error');
    } finally {
      delete process.env.ADMIN_OPERATOR_SECRET;
    }
  });

  test('missing scope + valid secret → 403 permission_error', async () => {
    process.env.ADMIN_OPERATOR_SECRET = 'super-long-operator-secret-123';
    try {
      const c = createMockContext({ operatorSecret: 'super-long-operator-secret-123' });
      const result = await requireAdminScopeMiddleware(c, next);
      expect(result).toBeInstanceOf(Response);
      expect(result!.status).toBe(403);
      const body = (await result!.json()) as { error: { code: string } };
      expect(body.error.code).toBe('permission_error');
    } finally {
      delete process.env.ADMIN_OPERATOR_SECRET;
    }
  });

  test('valid secret but missing header → 403 permission_error', async () => {
    process.env.ADMIN_OPERATOR_SECRET = 'super-long-operator-secret-123';
    try {
      const c = createMockContext({ scope: 'admin' });
      const result = await requireAdminScopeMiddleware(c, next);
      expect(result).toBeInstanceOf(Response);
      expect(result!.status).toBe(403);
      const body = (await result!.json()) as { error: { message: string } };
      expect(body.error.message).toContain('operator credentials');
    } finally {
      delete process.env.ADMIN_OPERATOR_SECRET;
    }
  });

  test('valid secret but wrong header → 403 permission_error', async () => {
    process.env.ADMIN_OPERATOR_SECRET = 'super-long-operator-secret-123';
    try {
      const c = createMockContext({
        scope: 'admin',
        operatorSecret: 'wrong-secret-value-999',
      });
      const result = await requireAdminScopeMiddleware(c, next);
      expect(result).toBeInstanceOf(Response);
      expect(result!.status).toBe(403);
      const body = (await result!.json()) as { error: { message: string } };
      expect(body.error.message).toContain('operator credentials');
    } finally {
      delete process.env.ADMIN_OPERATOR_SECRET;
    }
  });

  test('operator secret comparison uses timing-safe comparison', () => {
    const source = readFileSync(join(process.cwd(), 'src/middleware/admin-scope.ts'), 'utf8');

    expect(source).toContain('timingSafeEqual');
    expect(source).not.toContain('provided !== operatorSecret');
  });
});
