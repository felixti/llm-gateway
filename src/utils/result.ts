/**
 * Result type for explicit error handling - Either monad in TypeScript
 *
 * Usage:
 *   const result = safeParse(body, schema);
 *   if (!result.ok) return handleError(result.error);
 *   return processData(result.value);
 */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Create a successful Result
 */
export const ok = <T>(value: T): Result<T, never> => ({
  ok: true,
  value,
});

/**
 * Create a failed Result
 */
export const err = <E>(error: E): Result<never, E> => ({
  ok: false,
  error,
});

/**
 * Map over the value inside a Result (functor)
 */
export const map = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> =>
  result.ok ? ok(fn(result.value)) : result;

/**
 * Chain Result values (monad flatMap/bind)
 */
export const flatMap = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> =>
  result.ok ? fn(result.value) : result;

/**
 * Get value or default if error
 */
export const getOrElse = <T, E>(
  result: Result<T, E>,
  defaultValue: T
): T =>
  result.ok ? result.value : defaultValue;

/**
 * Check if Result is ok
 */
export const isOk = <T, E>(result: Result<T, E>): result is Result<T, never> =>
  result.ok;

/**
 * Check if Result is error
 */
export const isErr = <T, E>(result: Result<T, E>): result is Result<never, E> =>
  !result.ok;

/**
 * Option type for representing optional values (Maybe monad)
 */
export type Option<T> =
  | { readonly isSome: true; readonly value: T }
  | { readonly isNone: true };

export const some = <T>(value: T): Option<T> => ({ isSome: true, value });
export const none: Option<never> = { isNone: true };

export const mapOption = <T, U>(opt: Option<T>, fn: (value: T) => U): Option<U> =>
  opt.isSome ? some(fn(opt.value)) : none;

export const flatMapOption = <T, U>(opt: Option<T>, fn: (value: T) => Option<U>): Option<U> =>
  opt.isSome ? fn(opt.value) : none;

export const getOrElseOption = <T>(opt: Option<T>, defaultValue: T): T =>
  opt.isSome ? opt.value : defaultValue;

/**
 * Tuple types and helpers for common patterns
 */
export type Pair<A, B> = readonly [A, B];
export type Triple<A, B, C> = readonly [A, B, C];

export const tuple2 = <A, B>(a: A, b: B): Pair<A, B> => [a, b];
export const tuple3 = <A, B, C>(a: A, b: B, c: C): Triple<A, B, C> => [a, b, c];
