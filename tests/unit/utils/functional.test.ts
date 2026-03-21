import { describe, expect, it } from 'bun:test';
import {
  identity,
  compose2,
  pipe2,
  curry2,
  flip,
  constant,
} from '@/utils/functional';

describe('Functional utilities', () => {
  describe('identity', () => {
    it('should return input unchanged', () => {
      expect(identity(42)).toBe(42);
      expect(identity('hello')).toBe('hello');
    });
  });

  describe('compose2', () => {
    it('should compose two functions', () => {
      const addOne = (x: number) => x + 1;
      const double = (x: number) => x * 2;
      const composed = compose2(addOne, double);
      expect(composed(5)).toBe(12); // (5 + 1) * 2
    });
  });

  describe('pipe2', () => {
    it('should pipe two functions left to right', () => {
      const addOne = (x: number) => x + 1;
      const double = (x: number) => x * 2;
      const piped = pipe2(addOne, double);
      expect(piped(5)).toBe(12); // (5 + 1) * 2
    });
  });

  describe('curry2', () => {
    it('should curry binary function', () => {
      const add = (a: number, b: number) => a + b;
      const curriedAdd = curry2(add);
      expect(curriedAdd(1)(2)).toBe(3);
    });
  });

  describe('flip', () => {
    it('should flip argument order', () => {
      const div = (a: number, b: number) => a / b;
      const flippedDiv = flip(div);
      expect(flippedDiv(2, 6)).toBe(3); // 6 / 2
    });
  });

  describe('constant', () => {
    it('should always return the same value', () => {
      const always42 = constant(42);
      expect(always42()).toBe(42);
      expect(always42()).toBe(42);
    });
  });
});
