import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
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

  test('scope admin → next()', async () => {
    const c = createMockContext({ scope: 'admin' });
    const result = await requireAdminScopeMiddleware(c, next);
    expect(result).toBeUndefined();
  });

  test('scope all → 403', async () => {
    const c = createMockContext({ scope: 'all' });
    const result = await requireAdminScopeMiddleware(c, next);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);
  });

  test('missing scope → 403', async () => {
    const c = createMockContext({});
    const result = await requireAdminScopeMiddleware(c, next);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);
  });

  test('operator secret required: missing header → 403', async () => {
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

  test('operator secret required: matching header → next()', async () => {
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
});
