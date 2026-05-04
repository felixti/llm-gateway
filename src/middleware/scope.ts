/**
 * Scope Enforcement Middleware
 * Enforces PAT scope restrictions after authentication
 * Scopes: 'admin' (full LLM API access + operator routes), 'all' (full access),
 * 'read' (GET/HEAD/OPTIONS only), 'models:<name>' (read plus scoped model calls)
 */

import { errorForProtocol } from '@/utils/errors';
import type { Context, Next } from 'hono';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Scope enforcement middleware
 * Must run after authMiddleware (which sets the scope context variable)
 */
export async function scopeMiddleware(c: Context, next: Next): Promise<Response | undefined> {
  const scope = c.get('scope');
  const path = c.req.path;
  const method = c.req.method;

  // No scope set — auth middleware hasn't run or skipped
  if (!scope) {
    return c.json(
      errorForProtocol(path, 403, 'permission_error', 'Access denied: scope not set'),
      403
    );
  }

  // 'admin' tokens use the same LLM API rules as 'all' on these routes
  if (scope === 'admin') {
    await next();
    return;
  }

  // 'all' scope allows everything
  if (scope === 'all') {
    await next();
    return;
  }

  // 'read' scope allows only safe methods
  if (scope === 'read') {
    if (!READ_ONLY_METHODS.has(method)) {
      return c.json(
        errorForProtocol(
          path,
          403,
          'permission_error',
          `Scope '${scope}' does not allow ${method} requests`
        ),
        403
      );
    }
    await next();
    return;
  }

  if (typeof scope === 'string' && scope.startsWith('models:')) {
    await next();
    return;
  }

  // Unknown scope — deny by default
  return c.json(errorForProtocol(path, 403, 'permission_error', `Unknown scope: ${scope}`), 403);
}
