import type { MiddlewareHandler } from 'hono';

export type Family = 'openai-chat' | 'anthropic-messages';

export function protocolGuard(family: Family): MiddlewareHandler {
  return async (c, next) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
    const model = (body as { model?: unknown })?.model;
    if (typeof model !== 'string' || model.length === 0) return c.json({ error: 'missing model' }, 400);
    c.set('model', model);
    c.set('parsedBody', body);
    c.set('family', family);
    await next();
  };
}
