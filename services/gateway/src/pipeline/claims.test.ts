import { describe, it, expect } from 'vitest';
import { checkDuplicatePrincipalHeaders, parsePrincipalHeaders } from './claims';

describe('checkDuplicatePrincipalHeaders', () => {
  it('passes when no duplicate principal headers', () => {
    const raw = ['X-Principal-Id', 'a', 'Content-Type', 'application/json'];
    expect(checkDuplicatePrincipalHeaders(raw).ok).toBe(true);
  });
  it('rejects exact duplicate', () => {
    const raw = ['X-Principal-Id', 'a', 'X-Principal-Id', 'b'];
    expect(checkDuplicatePrincipalHeaders(raw).ok).toBe(false);
  });
  it('rejects case-variant duplicate', () => {
    const raw = ['X-Principal-Id', 'a', 'x-principal-id', 'b'];
    expect(checkDuplicatePrincipalHeaders(raw).ok).toBe(false);
  });
});

describe('parsePrincipalHeaders', () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it('builds UserAuth for an sp', () => {
    const r = parsePrincipalHeaders(h({
      'x-principal-id': 'app1', 'x-principal-kind': 'sp',
      'x-principal-project': 'proj1', 'x-principal-scopes': 'chat messages',
    }), 'internal');
    expect(r).toEqual({ ok: true, value: {
      principalId: 'app1', principalKind: 'sp', projectId: 'proj1', orgId: 'internal', scopes: ['chat', 'messages'],
    }});
  });
  it('builds UserAuth for a user with null project', () => {
    const r = parsePrincipalHeaders(h({ 'x-principal-id': 'oid1', 'x-principal-kind': 'user' }), 'internal');
    expect(r.ok && r.value.projectId).toBe(null);
  });
  it('rejects invalid kind', () => {
    expect(parsePrincipalHeaders(h({ 'x-principal-id': 'x', 'x-principal-kind': 'robot' }), 'internal').ok).toBe(false);
  });
  it('rejects sp without project', () => {
    expect(parsePrincipalHeaders(h({ 'x-principal-id': 'x', 'x-principal-kind': 'sp' }), 'internal').ok).toBe(false);
  });
  it('rejects missing id', () => {
    expect(parsePrincipalHeaders(h({ 'x-principal-kind': 'user' }), 'internal').ok).toBe(false);
  });
});
