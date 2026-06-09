/**
 * Function composition utilities for functional programming
 */

/**
 * Identity function - returns input unchanged
 */
export const identity = <T>(value: T): T => value;

/**
 * Compose two functions - applies fn1 then fn2
 * compose(f, g)(x) = g(f(x))
 */
export const compose2 =
  <A, B, C>(fn1: (a: A) => B, fn2: (b: B) => C): ((a: A) => C) =>
  (a) =>
    fn2(fn1(a));

/**
 * Compose three functions
 */
export const compose3 =
  <A, B, C, D>(fn1: (a: A) => B, fn2: (b: B) => C, fn3: (c: C) => D): ((a: A) => D) =>
  (a) =>
    fn3(fn2(fn1(a)));

/**
 * Pipe two functions - applies fn1 then fn2
 * pipe(f, g)(x) = g(f(x)) but reads left-to-right
 */
export const pipe2 =
  <A, B, C>(fn1: (a: A) => B, fn2: (b: B) => C): ((a: A) => C) =>
  (a) =>
    fn2(fn1(a));

/**
 * Pipe three functions
 */
export const pipe3 =
  <A, B, C, D>(fn1: (a: A) => B, fn2: (b: B) => C, fn3: (c: C) => D): ((a: A) => D) =>
  (a) =>
    fn3(fn2(fn1(a)));

/**
 * Curry a binary function
 */
export const curry2 =
  <A, B, R>(fn: (a: A, b: B) => R) =>
  (a: A) =>
  (b: B) =>
    fn(a, b);

/**
 * Curry a ternary function
 */
export const curry3 =
  <A, B, C, R>(fn: (a: A, b: B, c: C) => R) =>
  (a: A) =>
  (b: B) =>
  (c: C) =>
    fn(a, b, c);

/**
 * Flip arguments of a binary function
 */
export const flip =
  <A, B, C>(fn: (a: A, b: B) => C) =>
  (b: B, a: A) =>
    fn(a, b);

/**
 * Constant function - always returns the same value
 */
export const constant =
  <T>(value: T) =>
  () =>
    value;

/**
 * Throttle a function - ensures it runs at most once per interval
 */
export const throttle = <T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) => {
  let lastCall = 0;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn(...args);
    }
  };
};

/**
 * Partial application - fix some arguments of a function
 */
export const partial =
  <A, B, R>(fn: (a: A, b: B) => R, a: A): ((b: B) => R) =>
  (b) =>
    fn(a, b);
