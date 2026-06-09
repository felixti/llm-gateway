import type { MiddlewareHandler } from 'hono';

export type Allowlist = Record<string, string[]>;

export function scopeMiddleware(allowlist: Allowlist): MiddlewareHandler {
  return async (c, next) => {
    const { principalId } = c.get('userAuth');
    const model = c.get('model');
    const allowed = allowlist[principalId] ?? [];
    if (!allowed.includes(model)) return c.json({ error: 'model not allowed for principal' }, 403);
    await next();
  };
}
