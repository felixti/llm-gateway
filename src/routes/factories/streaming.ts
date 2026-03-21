/**
 * Streaming helpers for SSE response handling
 */

import { errorForProtocol } from '@/utils/errors';
import type { Context } from 'hono';

/**
 * Create a streaming error response
 */
export function createStreamingErrorResponse(
  c: Context,
  path: string,
  status: number,
  code: string,
  message: string
): Response {
  const error = errorForProtocol(path, status, code, message);
  return c.json(error, status as 400 | 401 | 403 | 429 | 502 | 503);
}
