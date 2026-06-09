import { Hono } from 'hono';
import './types';
import { healthRoutes } from './features/health/route';
import { authMiddleware, type AuthDeps } from './pipeline/auth';
import { protocolGuard } from './pipeline/protocol-guard';
import { scopeMiddleware } from './pipeline/scope';
import { tenantContextMiddleware } from './pipeline/tenant-context';
import type { ConfigStore } from './kernel/config-store/types';

export interface AppDeps {
  auth: AuthDeps;
  configStore: ConfigStore;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.route('/', healthRoutes);

  const api = new Hono();
  api.use('*', authMiddleware(deps.auth));
  api.use('*', tenantContextMiddleware(deps.configStore));

  api.post('/v1/chat/completions', protocolGuard('openai-chat'), scopeMiddleware(), (c) =>
    c.json({ stub: true, model: c.get('model'), principal: c.get('userAuth').principalId }));

  api.post('/v1/messages', protocolGuard('anthropic-messages'), scopeMiddleware(), (c) =>
    c.json({ stub: true, model: c.get('model'), principal: c.get('userAuth').principalId }));

  app.route('/', api);
  return app;
}
