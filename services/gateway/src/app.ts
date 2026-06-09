import { Hono } from 'hono';
import './types';
import { healthRoutes } from './features/health/route';
import type { AuthDeps } from './pipeline/auth';
import type { Allowlist } from './pipeline/scope';

export interface AppDeps {
  auth: AuthDeps;
  allowlist: Allowlist;
}

export function createApp(_deps: AppDeps) {
  const app = new Hono();
  app.route('/', healthRoutes); // unauthenticated
  return app;
}
