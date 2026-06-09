import type { MiddlewareHandler } from 'hono';

export function scopeMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const { modelAllowlist } = c.get('tenantContext');
    const model = c.get('model');
    if (!modelAllowlist.includes(model)) return c.json({ error: 'model not allowed for principal' }, 403);
    await next();
  };
}
