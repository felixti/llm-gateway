import type { MiddlewareHandler } from 'hono';
import { verifyM2mToken, type M2mVerifyOptions } from './m2m';
import { checkDuplicatePrincipalHeaders, parsePrincipalHeaders } from './claims';

export interface AuthDeps {
  orgId: string;
  m2m: M2mVerifyOptions;
}

export function authMiddleware(deps: AuthDeps): MiddlewareHandler {
  return async (c, next) => {
    const authz = c.req.header('authorization');
    if (!authz?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);

    const m2m = await verifyM2mToken(authz.slice(7), deps.m2m);
    if (!m2m.ok) return c.json({ error: 'unauthorized' }, 401);

    const incoming = (c.env as { incoming?: { rawHeaders?: string[] } } | undefined)?.incoming;
    const dup = checkDuplicatePrincipalHeaders(incoming?.rawHeaders ?? []);
    if (!dup.ok) return c.json({ error: 'unauthorized' }, 401);

    const parsed = parsePrincipalHeaders(c.req.raw.headers, deps.orgId);
    if (!parsed.ok) return c.json({ error: 'unauthorized' }, 401);

    c.set('userAuth', parsed.value);
    await next();
  };
}
