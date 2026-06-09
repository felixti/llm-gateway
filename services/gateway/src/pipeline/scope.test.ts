import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import '../types';
import { protocolGuard } from './protocol-guard';
import { scopeMiddleware } from './scope';

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('userAuth', { principalId: 'app1', principalKind: 'sp', projectId: 'p', orgId: 'internal', scopes: [] });
    c.set('tenantContext', {
      principalId: 'app1',
      principalKind: 'sp',
      projectId: 'p',
      orgId: 'internal',
      modelAllowlist: ['gpt-5.4'],
      budgetPolicy: null,
    });
    await next();
  });
  a.post('/x', protocolGuard('openai-chat'), scopeMiddleware(), (c) => c.json({ model: c.get('model') }));
  return a;
}

describe('protocolGuard + scope', () => {
  it('400 on invalid json', async () => {
    const res = await app().request('/x', { method: 'POST', body: 'nope', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });
  it('400 on missing model', async () => {
    const res = await app().request('/x', { method: 'POST', body: JSON.stringify({ messages: [] }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });
  it('403 when model not in allowlist', async () => {
    const res = await app().request('/x', { method: 'POST', body: JSON.stringify({ model: 'gpt-5-mini' }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(403);
  });
  it('200 when model allowed', async () => {
    const res = await app().request('/x', { method: 'POST', body: JSON.stringify({ model: 'gpt-5.4' }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: 'gpt-5.4' });
  });
});
