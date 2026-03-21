import { describe, expect, it } from 'bun:test';
import { ok, err, map, flatMap, isOk, isErr, getOrElse } from '@/utils/result';

describe('Result types', () => {
  describe('ok', () => {
    it('should create successful result', () => {
      const result = ok(42);
      expect(isOk(result)).toBe(true);
      expect(isErr(result)).toBe(false);
      // TypeScript narrowing issue with never type, use type assertion
      expect((result as { ok: true; value: number }).value).toBe(42);
    });
  });

  describe('err', () => {
    it('should create error result', () => {
      const result = err(new Error('fail'));
      expect(isErr(result)).toBe(true);
      expect(isOk(result)).toBe(false);
      expect((result as { ok: false; error: Error }).error.message).toBe('fail');
    });
  });

  describe('map', () => {
    it('should transform value in ok result', () => {
      const result = map(ok(21), (x) => x * 2);
      expect(isOk(result)).toBe(true);
      const r = result as { ok: true; value: number };
      expect(r.value).toBe(42);
    });

    it('should pass through error in err result', () => {
      const error = new Error('fail');
      const result = map(err(error), (x: number) => x * 2);
      expect(isErr(result)).toBe(true);
    });
  });

  describe('flatMap', () => {
    it('should chain successful results', () => {
      const result = flatMap(ok(21), (x) => ok(x * 2));
      expect(isOk(result)).toBe(true);
      const r = result as { ok: true; value: number };
      expect(r.value).toBe(42);
    });

    it('should short-circuit on error', () => {
      const result = flatMap(ok(21), () => err(new Error('fail')));
      expect(isErr(result)).toBe(true);
    });
  });

  describe('getOrElse', () => {
    it('should return value for ok result', () => {
      expect(getOrElse(ok(42), 0)).toBe(42);
    });

    it('should return default for error result', () => {
      expect(getOrElse(err(new Error('fail')), 0)).toBe(0);
    });
  });
});
