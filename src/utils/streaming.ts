/**
 * Streaming Utilities
 * SSE parsing TransformStream for OpenAI and Anthropic protocols
 * Handles usage extraction for quota reconciliation
 */

import type { TokenUsage } from '../services/pricing.service';

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

/**
 * Create a TransformStream for OpenAI SSE that intercepts usage from final chunk
 * Usage is extracted and passed via custom header, all chunks pass through
 */
export function createOpenAIStreamTransformer() {
  const state: OpenAIStreamState = {
    usage: null,
    done: false,
  };

  return {
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController): void {
      const text = new TextDecoder().decode(chunk);
      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          state.done = true;
          controller.enqueue(chunk);
          continue;
        }

        try {
          const parsed = JSON.parse(data) as OpenAIStreamChunk;

          // Intercept usage from final chunk
          if (parsed.usage) {
            state.usage = {
              prompt_tokens: parsed.usage.prompt_tokens,
              completion_tokens: parsed.usage.completion_tokens,
              total_tokens: parsed.usage.total_tokens,
            };
          }

          // Also check if this is a final chunk with finish_reason
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason && !parsed.choices[0].delta) {
            // This appears to be a final chunk with usage - extract and signal
            controller.enqueue(chunk);
          } else {
            controller.enqueue(chunk);
          }
        } catch {
          // Pass through malformed JSON as-is
          controller.enqueue(chunk);
        }
      }
    },

    flush(controller: TransformStreamDefaultController): void {
      // Ensure usage is available after stream ends
      controller.terminate();
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
      const parsed = JSON.parse(data) as OpenAIStreamChunk;
      if (parsed.usage) {
        return {
          prompt_tokens: parsed.usage.prompt_tokens,
          completion_tokens: parsed.usage.completion_tokens,
          thinking_tokens: undefined,
          cache_creation_input_tokens: undefined,
          cache_read_input_tokens: undefined,
        };
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

/**
 * Create a TransformStream for Anthropic SSE that intercepts message_delta for usage
 * All other events pass through natively
 */
export function createAnthropicStreamTransformer() {
  return {
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController): void {
      // Pass through all chunks - Anthropic streaming is native passthrough
      // We only intercept for usage tracking
      controller.enqueue(chunk);
    },

    flush(controller: TransformStreamDefaultController): void {
      controller.terminate();
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
      const event = JSON.parse(data) as AnthropicStreamEvent;
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
      events.push(JSON.parse(data) as AnthropicStreamEvent);
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
  releaseFn: (id: string) => Promise<void>
): () => void {
  return () => {
    if (reservationId) {
      releaseFn(reservationId).catch((err) => {
        console.error('Failed to release reservation on abort:', err);
      });
    }
  };
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
