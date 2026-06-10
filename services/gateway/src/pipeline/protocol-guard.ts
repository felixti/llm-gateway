import type { MiddlewareHandler } from 'hono';

export type Family = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export function protocolGuard(family: Family): MiddlewareHandler {
  return async (c, next) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const model = (body as { model?: unknown })?.model;
    if (typeof model !== 'string' || model.length === 0) {
      return c.json({ error: 'missing model' }, 400);
    }
    c.set('model', model);
    c.set('parsedBody', body);
    c.set('family', family);
    await next();
  };
}

/** OpenAI-compatible routes accept any configured Azure model (adapter bridges protocols). */
export function openAiRouteGuard(): MiddlewareHandler {
  return protocolGuard('openai-chat');
}

export function responsesRouteGuard(): MiddlewareHandler {
  return protocolGuard('openai-responses');
}
