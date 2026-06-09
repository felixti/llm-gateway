import { describe, it, expect } from 'vitest';
import { PRINCIPAL_HEADERS } from '@shared/contracts/claims';
import { ok, err } from '@shared/result';

describe('shared contracts', () => {
  it('exposes lowercase principal header names', () => {
    expect(PRINCIPAL_HEADERS).toEqual({
      id: 'x-principal-id',
      kind: 'x-principal-kind',
      project: 'x-principal-project',
      scopes: 'x-principal-scopes',
    });
  });

  it('Result ok/err discriminate', () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
    expect(err('bad')).toEqual({ ok: false, error: 'bad' });
  });
});
