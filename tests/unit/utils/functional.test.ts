import { describe, expect, it } from 'bun:test';
import {
  identity,
  compose2,
  compose3,
  pipe2,
  pipe3,
  curry2,
  curry3,
  flip,
  constant,
  throttle,
  partial,
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

  describe('compose3', () => {
    it('should compose three functions', () => {
      const addOne = (x: number) => x + 1;
      const double = (x: number) => x * 2;
      const triple = (x: number) => x * 3;
      const composed = compose3(addOne, double, triple);
      expect(composed(5)).toBe(36); // ((5 + 1) * 2) * 3
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

  describe('pipe3', () => {
    it('should pipe three functions left to right', () => {
      const addOne = (x: number) => x + 1;
      const double = (x: number) => x * 2;
      const triple = (x: number) => x * 3;
      const piped = pipe3(addOne, double, triple);
      expect(piped(5)).toBe(36); // ((5 + 1) * 2) * 3
    });
  });

  describe('curry2', () => {
    it('should curry binary function', () => {
      const add = (a: number, b: number) => a + b;
      const curriedAdd = curry2(add);
      expect(curriedAdd(1)(2)).toBe(3);
    });
  });

  describe('curry3', () => {
    it('should curry ternary function', () => {
      const add3 = (a: number, b: number, c: number) => a + b + c;
      const curriedAdd3 = curry3(add3);
      expect(curriedAdd3(1)(2)(3)).toBe(6);
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

  describe('throttle', () => {
    it('should call function immediately on first invocation', () => {
      let count = 0;
      const increment = () => { count++; };
      const throttled = throttle(increment, 100);
      throttled();
      expect(count).toBe(1);
    });

    it('should not call function again within delay', () => {
      let count = 0;
      const increment = () => { count++; };
      const throttled = throttle(increment, 100);
      throttled();
      throttled();
      throttled();
      expect(count).toBe(1);
    });
  });

  describe('partial', () => {
    it('should fix the first argument', () => {
      const greet = (greeting: string, name: string) => `${greeting}, ${name}`;
      const sayHello = partial(greet, 'Hello');
      expect(sayHello('World')).toBe('Hello, World');
    });
  });
});
