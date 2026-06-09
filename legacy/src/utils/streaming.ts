/**
 * Streaming Utilities
 * SSE parsing TransformStream for OpenAI and Anthropic protocols
 * Handles usage extraction for quota reconciliation
 */

import { logger } from '@/observability/logger';
import type { TokenUsage } from '@/services/pricing.service';

// =============================================================================
// SSE Parser TransformStream
// =============================================================================

// =============================================================================
// OpenAI Chat Completions Stream Handler
// =============================================================================

export interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIStreamState {
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
  done: boolean;
}

export interface OpenAIUsageObserver {
  observe(chunk: Uint8Array): void;
  flush(): void;
}

interface OpenAIStreamTransformerOptions {
  onUsage?: (usage: TokenUsage) => void;
  onEnd?: () => void | Promise<void>;
}

function toTokenUsage(usage: OpenAIStreamChunk['usage']): TokenUsage | null {
  if (!usage) {
    return null;
  }

  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    thinking_tokens: undefined,
    cache_creation_input_tokens: undefined,
    cache_read_input_tokens: undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasValidOpenAIUsage(value: unknown): value is OpenAIStreamChunk['usage'] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNumber(value.prompt_tokens) &&
    isNumber(value.completion_tokens) &&
    isNumber(value.total_tokens)
  );
}

function hasValidAnthropicUsage(
  value: unknown
): value is NonNullable<AnthropicStreamEvent['usage']> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNumber(value.input_tokens) &&
    isNumber(value.output_tokens) &&
    (value.thinking_tokens === undefined || isNumber(value.thinking_tokens))
  );
}

export function isOpenAIStreamChunk(value: unknown): value is OpenAIStreamChunk {
  if (!isRecord(value)) {
    return false;
  }

  return value.usage === undefined || hasValidOpenAIUsage(value.usage);
}

function parseOpenAIUsageFromData(data: string): TokenUsage | null {
  if (data === '[DONE]' || data.length < 10 || !data.includes('usage')) {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isOpenAIStreamChunk(parsed)) {
      return null;
    }
    return toTokenUsage(parsed.usage);
  } catch {
    return null;
  }
}

export function createOpenAIUsageObserver(
  onUsage: (usage: TokenUsage) => void
): OpenAIUsageObserver {
  const decoder = new TextDecoder();
  let buffer = '';
  let emitted = false;

  const processLine = (line: string) => {
    if (emitted || !line.startsWith('data:')) {
      return;
    }

    const usage = parseOpenAIUsageFromData(line.slice(5).trim());
    if (!usage) {
      return;
    }

    emitted = true;
    onUsage(usage);
  };

  const processBuffer = () => {
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line);
    }
  };

  return {
    observe(chunk: Uint8Array): void {
      if (emitted) {
        return;
      }

      buffer += decoder.decode(chunk, { stream: true });
      processBuffer();
    },

    flush(): void {
      if (emitted) {
        return;
      }

      buffer += decoder.decode();
      if (buffer) {
        processLine(buffer);
        buffer = '';
      }
    },
  };
}

/**
 * Create a TransformStream for OpenAI SSE that intercepts usage from final chunk
 * Usage is extracted and passed via custom header, all chunks pass through
 */
export function createOpenAIStreamTransformer(options: OpenAIStreamTransformerOptions = {}) {
  const state: OpenAIStreamState = {
    usage: null,
    done: false,
  };
  const observer = createOpenAIUsageObserver((usage) => {
    state.usage = {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
    };
    options.onUsage?.(usage);
  });

  let controllerRef: TransformStreamDefaultController | null = null;
  const encoder = new TextEncoder();

  return {
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController): void {
      controllerRef = controller;
      const text = new TextDecoder().decode(chunk);
      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          state.done = true;
          continue;
        }

        observer.observe(chunk);
        break;
      }

      controller.enqueue(chunk);
    },

    async flush(controller: TransformStreamDefaultController): Promise<void> {
      controllerRef = controller;
      observer.flush();
      await options.onEnd?.();
      controller.terminate();
      controllerRef = null;
    },

    emitError(code: string, message: string): void {
      if (!controllerRef) return;
      try {
        const errEvent = `data: ${JSON.stringify({
          error: { type: 'server_error', code, message },
        })}\n\n`;
        controllerRef.enqueue(encoder.encode(errEvent));
        controllerRef.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch {
        void 0;
      }
    },
  };
}

/**
 * Extract usage from OpenAI stream final chunk
 */
export function extractOpenAIUsage(text: string): TokenUsage | null {
  const lines = text.split(/\r?\n/);

  for (const line of lines.reverse()) {
    if (!line.startsWith('data:')) continue;

    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;

    try {
      const parsed = JSON.parse(data) as unknown;
      if (!isOpenAIStreamChunk(parsed)) {
        continue;
      }
      const usage = toTokenUsage(parsed.usage);
      if (usage) {
        return usage;
      }
    } catch {
      // Continue searching
    }
  }

  return null;
}

// =============================================================================
// Anthropic Messages Stream Handler
// =============================================================================

export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    thinking_tokens?: number;
  };
  message?: {
    id: string;
    type: string;
    role: string;
    content: Array<Record<string, unknown>>;
  };
}

export function isAnthropicStreamEvent(value: unknown): value is AnthropicStreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  return value.usage === undefined || hasValidAnthropicUsage(value.usage);
}

/**
 * Create a TransformStream for Anthropic SSE that intercepts message_delta for usage
 * All other events pass through natively
 */
export function createAnthropicStreamTransformer() {
  let controllerRef: TransformStreamDefaultController | null = null;
  const encoder = new TextEncoder();

  return {
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController): void {
      controllerRef = controller;
      controller.enqueue(chunk);
    },

    flush(controller: TransformStreamDefaultController): void {
      controllerRef = controller;
      controller.terminate();
      controllerRef = null;
    },

    emitError(code: string, message: string): void {
      if (!controllerRef) return;
      try {
        const errEvent = `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'server_error', code, message },
        })}\n\n`;
        controllerRef.enqueue(encoder.encode(errEvent));
      } catch {
        void 0;
      }
    },
  };
}

/**
 * Extract usage from Anthropic message_delta event
 */
export function extractAnthropicUsage(text: string): TokenUsage | null {
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;

    const data = line.slice(5).trim();
    try {
      const event = JSON.parse(data) as unknown;
      if (!isAnthropicStreamEvent(event)) {
        continue;
      }
      if (event.type === 'message_delta' && event.usage) {
        return {
          prompt_tokens: event.usage.input_tokens,
          completion_tokens: event.usage.output_tokens,
          thinking_tokens: event.usage.thinking_tokens,
          cache_creation_input_tokens: undefined,
          cache_read_input_tokens: undefined,
        };
      }
    } catch {
      // Continue
    }
  }

  return null;
}

/**
 * Parse Anthropic SSE events from text
 */
export function parseAnthropicEvents(text: string): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;

    const data = line.slice(5).trim();
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isAnthropicStreamEvent(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Skip malformed
    }
  }

  return events;
}

// =============================================================================
// Abort Handler Helper
// =============================================================================

/**
 * Handle client abort - release quota reservation
 * Returns cleanup function
 */
export function handleStreamAbort(
  reservationId: string | null,
  releaseFn: () => Promise<void>,
  signal?: AbortSignal
): () => Promise<void> {
  let released = false;

  const releaseOnce = async () => {
    if (released || !reservationId) {
      return;
    }

    released = true;
    try {
      await releaseFn();
    } catch (err) {
      logger.warn({ err, reservationId }, 'Failed to release reservation on stream abort');
    }
  };

  if (signal) {
    if (signal.aborted) {
      releaseOnce();
    } else {
      signal.addEventListener('abort', releaseOnce, { once: true });
    }
  }

  return releaseOnce;
}

// =============================================================================
// Stream Status
// =============================================================================

export interface StreamStatus {
  usage: TokenUsage | null;
  done: boolean;
}

/**
 * Get current stream status
 */
export function getStreamStatus(state: OpenAIStreamState): StreamStatus {
  return {
    usage: state.usage
      ? {
          prompt_tokens: state.usage.prompt_tokens,
          completion_tokens: state.usage.completion_tokens,
          thinking_tokens: undefined,
          cache_creation_input_tokens: undefined,
          cache_read_input_tokens: undefined,
        }
      : null,
    done: state.done,
  };
}
