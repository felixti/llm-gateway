import { Hono } from 'hono';
import './types';
import { healthRoutes } from './features/health/route';
import { authMiddleware, type AuthDeps } from './pipeline/auth';
import { protocolGuard } from './pipeline/protocol-guard';
import { scopeMiddleware, type Allowlist } from './pipeline/scope';

export interface AppDeps {
  auth: AuthDeps;
  allowlist: Allowlist;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.route('/', healthRoutes);

  const api = new Hono();
  api.use('*', authMiddleware(deps.auth));

  api.post('/v1/chat/completions', protocolGuard('openai-chat'), scopeMiddleware(deps.allowlist), (c) =>
    c.json({ stub: true, model: c.get('model'), principal: c.get('userAuth').principalId }));

  api.post('/v1/messages', protocolGuard('anthropic-messages'), scopeMiddleware(deps.allowlist), (c) =>
    c.json({ stub: true, model: c.get('model'), principal: c.get('userAuth').principalId }));

  app.route('/', api);
  return app;
}
