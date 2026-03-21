/**
 * Streaming helpers for SSE response handling
 */

import type { Context } from 'hono';
import { errorForProtocol } from '@/utils/errors';

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
  return c.json(error, status);
}
