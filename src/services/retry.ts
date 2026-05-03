/**
 * Retry Service
 * Exponential backoff with jitter, respects Retry-After header,
 * skips retry for non-retryable errors (400, 401, 403)
 */

import { upstreamHttpsFetch } from '@/utils/fetch';

export interface RetryOptions {
  maxRetries?: number; // Default: 3
  maxBackoffMs?: number; // Default: 30000 (30s)
  baseDelayMs?: number; // Default: 1000 (1s)
  /** Abort signal: stops retries and aborts any pending sleep on abort. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_BASE_DELAY_MS = 1_000;

// Non-retryable HTTP status codes
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403]);

/**
 * Calculate exponential backoff delay with jitter
 * Sequence: 1s, 2s, 4s, 8s (capped at maxBackoffMs)
 * With ±1s jitter
 */
export function calculateBackoff(
  attempt: number,
  maxBackoffMs: number = DEFAULT_MAX_BACKOFF_MS,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS
): number {
  // Calculate exponential delay: baseDelay * 2^(attempt-1)
  const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);

  // Cap at max backoff
  const cappedDelay = Math.min(exponentialDelay, maxBackoffMs);

  // Add jitter: ±1s (random value between -1000 and +1000)
  const jitter = Math.random() * 2_000 - 1_000;

  // Ensure delay is at least 0
  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Check if a status code is non-retryable
 */
export function isNonRetryable(status: number): boolean {
  return NON_RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Extract Retry-After header value in seconds
 */
export function parseRetryAfterHeader(headers: Headers): number | null {
  const retryAfter = headers.get('Retry-After');
  if (!retryAfter) return null;

  // Try parsing as seconds first
  const seconds = Number.parseInt(retryAfter, 10);
  if (!Number.isNaN(seconds)) {
    return seconds * 1_000; // Convert to milliseconds
  }

  // Try parsing as HTTP date
  const date = Date.parse(retryAfter);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

/**
 * Sleep for specified milliseconds. If an AbortSignal is provided, the sleep
 * resolves early when the signal aborts (does NOT reject — callers decide).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Check whether an error indicates the request was aborted (client disconnect
 * or gateway timeout). Abort errors must NOT be retried.
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return false;
}

/**
 * Extract status from an error object (supports Response and custom error objects)
 */
function getStatusFromError(error: unknown): number {
  if (error instanceof Response) {
    return error.status;
  }
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status;
  }
  return 0;
}

function shouldRetryResponse(response: Response): boolean {
  return response.status >= 500 && !isNonRetryable(response.status);
}

/**
 * Execute a function with retry logic
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const signal = options.signal;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (signal?.aborted) {
      throw lastError ?? new DOMException('Request aborted before retry attempt', 'AbortError');
    }

    try {
      const result = await fn();
      if (result instanceof Response && shouldRetryResponse(result)) {
        throw result;
      }
      return result;
    } catch (error: unknown) {
      lastError = error;

      // Never retry aborted fetches — the caller is already gone (client
      // disconnect) or the gateway timeout fired.
      if (isAbortError(error) || signal?.aborted) {
        throw error;
      }

      // If this was the last attempt, throw immediately (no sleep)
      if (attempt > maxRetries) {
        break;
      }

      // Check for non-retryable errors
      const status = getStatusFromError(error);
      if (status && isNonRetryable(status)) {
        throw error;
      }

      // Calculate delay
      let delay = calculateBackoff(attempt, maxBackoffMs, baseDelayMs);

      // Check for Retry-After header if we have a Response object
      if (error instanceof Response) {
        const retryAfterMs = parseRetryAfterHeader(error.headers);
        if (retryAfterMs !== null) {
          delay = retryAfterMs;
        }
      }

      // Wait before next retry (interruptible by signal)
      await sleep(delay, signal);
    }
  }

  throw lastError;
}

/**
 * Create a retry-aware fetch function
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit & { retryOptions?: RetryOptions } = {},
  retryOptions?: RetryOptions
): Promise<Response> {
  const opts = retryOptions ?? options.retryOptions ?? {};

  return withRetry(() => upstreamHttpsFetch(url, options), opts);
}
