import { describe, expect, it } from 'vitest';
import { budgetKeys, budgetScopeTag } from '@shared/budget/keys';
import { fromMicrodollars, multiplyMicro, toMicrodollars } from '@shared/budget/money';

describe('budgetScopeTag', () => {
  it('tags user principals by oid', () => {
    expect(
      budgetScopeTag({ principalKind: 'user', principalId: 'oid-1', projectId: null }),
    ).toBe('{user:oid-1}');
  });

  it('tags service principals by project id', () => {
    expect(
      budgetScopeTag({ principalKind: 'sp', principalId: 'app-1', projectId: 'proj-9' }),
    ).toBe('{proj:proj-9}');
  });
});

describe('budgetKeys + microdollars', () => {
  it('builds hash-tagged keys under one scope', () => {
    const scope = '{user:oid-1}';
    const keys = budgetKeys(scope);
    expect(keys.spent).toBe('{user:oid-1}:spent');
    expect(keys.reservation('r1')).toBe('{user:oid-1}:resv:r1');
    expect(keys.rpm(42)).toBe('{user:oid-1}:rpm:42');
  });

  it('converts USD strings to microdollars and back', () => {
    const micro = toMicrodollars('1.234567');
    expect(micro).toBe(1_234_567n);
    expect(fromMicrodollars(micro)).toBe('1.234567');
    expect(multiplyMicro(micro, 1.2)).toBe(1_481_481n);
  });
});
