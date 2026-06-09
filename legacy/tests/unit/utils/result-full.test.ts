import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  ok,
  err,
  map,
  flatMap,
  isOk,
  isErr,
  getOrElse,
  some,
  none,
  isSome,
  isNone,
  mapOption,
  flatMapOption,
  getOrElseOption,
  tuple2,
  tuple3,
} from '@/utils/result';

describe('Result type - full coverage', () => {
  describe('map on err', () => {
    it('passes through err without calling fn', () => {
      const result = map(err('fail'), (x: number) => x * 2);
      expect(isErr(result)).toBe(true);
      const r = result as { ok: false; error: string };
      expect(r.error).toBe('fail');
    });
  });

  describe('flatMap on err', () => {
    it('passes through err without calling fn', () => {
      const result = flatMap(err('fail'), (x: number) => ok(x * 2));
      expect(isErr(result)).toBe(true);
      const r = result as { ok: false; error: string };
      expect(r.error).toBe('fail');
    });
  });
});

describe('Option type', () => {
  describe('some', () => {
    it('creates a some value', () => {
      const opt = some(42);
      expect(isSome(opt)).toBe(true);
      expect(isNone(opt)).toBe(false);
      expect((opt as { isSome: true; value: number }).value).toBe(42);
    });
  });

  describe('none', () => {
    it('creates a none value', () => {
      const opt = none;
      expect(isNone(opt)).toBe(true);
      expect(isSome(opt)).toBe(false);
    });
  });

  describe('mapOption', () => {
    it('transforms some value', () => {
      const result = mapOption(some(21), (x) => x * 2);
      expect(isSome(result)).toBe(true);
      expect((result as { isSome: true; value: number }).value).toBe(42);
    });

    it('passes through none', () => {
      const result = mapOption(none, (x: number) => x * 2);
      expect(isNone(result)).toBe(true);
    });
  });

  describe('flatMapOption', () => {
    it('chains some values', () => {
      const result = flatMapOption(some(21), (x) => some(x * 2));
      expect(isSome(result)).toBe(true);
      expect((result as { isSome: true; value: number }).value).toBe(42);
    });

    it('returns none when fn returns none', () => {
      const result = flatMapOption(some(21), () => none);
      expect(isNone(result)).toBe(true);
    });

    it('passes through none without calling fn', () => {
      const result = flatMapOption(none, (x: number) => some(x * 2));
      expect(isNone(result)).toBe(true);
    });
  });

  describe('getOrElseOption', () => {
    it('returns value for some', () => {
      expect(getOrElseOption(some(42), 0)).toBe(42);
    });

    it('returns default for none', () => {
      expect(getOrElseOption(none, 0)).toBe(0);
    });
  });
});

describe('Tuple helpers', () => {
  it('tuple2 creates a pair', () => {
    const pair = tuple2(1, 'a');
    expect(pair).toEqual([1, 'a']);
    expect(pair.length).toBe(2);
  });

  it('tuple3 creates a triple', () => {
    const triple = tuple3(1, 'a', true);
    expect(triple).toEqual([1, 'a', true]);
    expect(triple.length).toBe(3);
  });
});
