import { describe, it, expect } from 'vitest';
import { createApp } from '../../app';

const deps = {
  auth: { orgId: 'internal', m2m: { jwks: (async () => { throw new Error('unused'); }) as any, issuer: 'i', audience: 'a', appId: 'x' } },
  allowlist: {},
};

describe('health', () => {
  it('GET /health → 200 ok', async () => {
    const res = await createApp(deps).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
