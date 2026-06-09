/**
 * Error handling helpers with Result types for request handlers
 * Provides consistent error formatting across protocols
 */

import { errorForProtocol } from '@/utils/errors';
import { type Result, err, ok } from '@/utils/result';
import type { Context } from 'hono';
import type { ZodSchema } from 'zod';

/**
 * Error types for request handling
 */
export type RequestError =
  | { type: 'invalid_json'; message: string }
  | { type: 'validation_error'; path: string; message: string }
  | { type: 'deployment_not_found'; model: string }
  | { type: 'circuit_open'; message: string }
  | { type: 'authentication_error'; message: string };

/**
 * Create error response from RequestError
 */
export function createRequestErrorResponse(
  c: Context,
  path: string,
  error: RequestError
): Response {
  const { status, code, message } = errorToStatusCode(error, path);
  const body = errorForProtocol(path, status, code, message);
  return c.json(body, status as 400 | 401 | 403 | 429 | 502 | 503);
}

/**
 * Convert RequestError to HTTP status/code/message
 */
function errorToStatusCode(
  error: RequestError,
  _path: string
): { status: number; code: string; message: string } {
  switch (error.type) {
    case 'invalid_json':
      return { status: 400, code: 'invalid_request', message: error.message };
    case 'validation_error':
      return { status: 400, code: 'invalid_request', message: `${error.path}: ${error.message}` };
    case 'deployment_not_found':
      return { status: 400, code: 'model_not_supported', message: `Unknown model: ${error.model}` };
    case 'circuit_open':
      return {
        status: 503,
        code: 'service_unavailable',
        message: 'Service temporarily unavailable, please retry',
      };
    case 'authentication_error':
      return { status: 401, code: 'authentication_error', message: error.message };
  }
}

/**
 * Wrap Zod validation result in Result type
 */
export function validateBody<T>(body: unknown, schema: ZodSchema): Result<T, RequestError> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    return err({
      type: 'validation_error',
      path: firstError.path.join('.'),
      message: firstError.message,
    });
  }

  return ok(parsed.data as T);
}
