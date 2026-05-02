/**
 * Structured JSON Logger
 * Uses pino for production-grade logging with PII sanitization
 */

import { env } from '@/config/env';
import pino from 'pino';
import { createPIISanitizeStream } from './pino-pii-transport';
import { sanitizePII } from './sanitize-pii';

export { sanitizePII };

/**
 * Create pino logger instance with structured output
 */
export function createLogger(name?: string): pino.Logger {
  const piiStream = createPIISanitizeStream(pino.destination({ sync: true }));

  const baseLogger = pino(
    {
      level: env.LOG_LEVEL,
      formatters: {
        level: (label) => ({ level: label }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      base: name ? { service: name } : undefined,
    },
    piiStream
  );

  return baseLogger;
}

// Default logger instance
export const logger = createLogger('llm-gateway');

/**
 * Request log context interface
 */
export interface RequestLogContext {
  traceId?: string | null;
  userId?: string;
  model?: string;
  tokens?: number;
  cost?: number;
  duration?: number;
  status?: number;
  protocol?: string;
}

export interface RequestBodyLogMetadata {
  model?: string;
  stream?: boolean;
  messageCount?: number;
  inputItemCount?: number;
  inputType?: 'string' | 'array' | 'unknown';
  toolCount?: number;
  functionCount?: number;
  hasSystem?: boolean;
  thinkingEnabled?: boolean;
  maxTokens?: number;
  maxCompletionTokens?: number;
  responseFormat?: string;
}

/**
 * Format request log entry with all context fields
 */
export function formatRequestLog(ctx: RequestLogContext): object {
  return {
    timestamp: new Date().toISOString(),
    trace_id: ctx.traceId ?? 'unknown',
    user_id: ctx.userId ?? 'unknown',
    model: ctx.model ?? 'unknown',
    tokens: ctx.tokens ?? 0,
    cost_usd: ctx.cost ?? 0,
    duration_ms: ctx.duration ?? 0,
    status: ctx.status ?? 0,
    protocol: ctx.protocol ?? 'unknown',
  };
}

/**
 * Create child logger with request context
 */
export function createRequestLogger(context: RequestLogContext): pino.Logger {
  return logger.child(formatRequestLog(context));
}

/**
 * Log request completion (info level)
 */
export function logRequest(ctx: RequestLogContext, message: string): void {
  const sanitizedCtx = sanitizePII(ctx) as RequestLogContext;
  const logEntry = formatRequestLog(sanitizedCtx);
  logger.info(logEntry, message);
}

/**
 * Log request error (error level)
 */
export function logError(ctx: RequestLogContext, error: Error, message: string): void {
  const sanitizedCtx = sanitizePII(ctx) as RequestLogContext;
  const logEntry = {
    ...formatRequestLog(sanitizedCtx),
    error: {
      message: error.message,
      name: error.name,
      stack: error.stack,
    },
  };
  logger.error(logEntry, message);
}

/**
 * Log warning (warn level)
 */
export function logWarning(ctx: RequestLogContext, message: string): void {
  const sanitizedCtx = sanitizePII(ctx) as RequestLogContext;
  const logEntry = formatRequestLog(sanitizedCtx);
  logger.warn(logEntry, message);
}

function countArray(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function getResponseFormatType(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'type' in value) {
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

/**
 * Summarize a request body without retaining prompt, message, input, or tool payload content.
 */
export function getRequestBodyLogMetadata(body: Record<string, unknown>): RequestBodyLogMetadata {
  const input = body.input;
  const thinking = body.thinking as { type?: unknown } | undefined;

  return {
    model: typeof body.model === 'string' ? body.model : undefined,
    stream: typeof body.stream === 'boolean' ? body.stream : undefined,
    messageCount: countArray(body.messages),
    inputItemCount: Array.isArray(input) ? input.length : undefined,
    inputType: typeof input === 'string' ? 'string' : Array.isArray(input) ? 'array' : undefined,
    toolCount: countArray(body.tools),
    functionCount: countArray(body.functions),
    hasSystem: body.system !== undefined,
    thinkingEnabled: thinking?.type === 'enabled',
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    maxCompletionTokens:
      typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined,
    responseFormat: getResponseFormatType(body.response_format),
  };
}

/**
 * Log request/response body metadata at DEBUG level.
 *
 * SECURITY: This function only accepts structured metadata (counts/types/flags).
 * It MUST NOT accept raw request/response bodies — that would risk logging
 * prompt/message content. The previous `logDebugBody()` helper was removed
 * deliberately to make this guarantee enforceable at the type level.
 */
export function logDebugRequestMetadata(
  direction: 'request' | 'response' | 'fallback',
  metadata: RequestBodyLogMetadata | Record<string, unknown>,
  ctx?: RequestLogContext
): void {
  if (env.LOG_LEVEL !== 'debug') {
    return;
  }

  const logEntry = {
    ...formatRequestLog(ctx ?? {}),
    direction,
    metadata: sanitizePII(metadata),
  };
  logger.debug(logEntry, `${direction} metadata`);
}
