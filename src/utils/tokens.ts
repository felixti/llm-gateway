/**
 * Token Estimation Utilities
 * Uses tiktoken for accurate token counting with fallback for Claude models
 * and thinking-enabled requests
 */

// tiktoken uses named exports - get_encoding returns a Tiktoken instance
import { type Tiktoken, get_encoding } from 'tiktoken';

// Singleton encoder instance for cl100k_base
let encoder: Tiktoken | null = null;

/**
 * Claude model identifier prefix
 */
const CLAUDE_MODEL_PREFIX = 'claude-';

/**
 * Fallback: characters per token ratio
 */
const FALLBACK_CHARS_PER_TOKEN = 4;

/**
 * Fallback: overhead constant
 */
const FALLBACK_OVERHEAD = 100;

/**
 * Claude multiplier for token estimation
 */
const CLAUDE_MULTIPLIER = 1.1;

/**
 * Thinking mode buffer multiplier
 */
const THINKING_BUFFER = 1.2;

export interface EstimateTokensOptions {
  /**
   * Whether thinking mode is enabled (for Claude models)
   */
  thinkingEnabled?: boolean;
}

/**
 * Initialize tiktoken encoder with cl100k_base encoding
 * Returns null if initialization fails
 */
function getEncoder(): Tiktoken | null {
  if (encoder) return encoder;

  try {
    // get_encoding returns a Tiktoken instance for the specified encoding
    encoder = get_encoding('cl100k_base');
    return encoder;
  } catch {
    return null;
  }
}

/**
 * Estimate tokens using tiktoken with cl100k_base encoding
 */
function estimateWithTiktoken(text: string): number {
  const enc = getEncoder();
  if (!enc) {
    return estimateWithFallback(text);
  }

  try {
    const tokens = enc.encode(text);
    return tokens.length;
  } catch {
    return estimateWithFallback(text);
  }
}

/**
 * Fallback estimation: 4 chars/token + 100 overhead
 */
function estimateWithFallback(text: string): number {
  if (!text || text.length === 0) return 0;
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN) + FALLBACK_OVERHEAD;
}

/**
 * Check if a model is a Claude model
 */
function isClaudeModel(model: string): boolean {
  return model.toLowerCase().startsWith(CLAUDE_MODEL_PREFIX);
}

/**
 * Estimate tokens for a given text and model
 *
 * @param text - The text to estimate tokens for
 * @param model - The model identifier (e.g., "gpt-5.4", "claude-opus-4-6")
 * @param options - Optional configuration
 * @returns Estimated token count
 */
export function estimateTokens(
  text: string,
  model: string,
  options?: EstimateTokensOptions
): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // Get base estimate using tiktoken or fallback
  let baseTokens = estimateWithTiktoken(text);

  // Apply Claude multiplier if applicable
  if (isClaudeModel(model)) {
    baseTokens = Math.ceil(baseTokens * CLAUDE_MULTIPLIER);
  }

  // Apply thinking buffer ONLY for Claude models when thinking is enabled
  if (options?.thinkingEnabled && isClaudeModel(model)) {
    baseTokens = Math.ceil(baseTokens * THINKING_BUFFER);
  }

  return baseTokens;
}

/**
 * Estimate tokens from an array of messages (OpenAI format)
 */
export function estimateMessagesTokens(
  messages: Array<{ role?: string; content?: string }>,
  model: string,
  options?: EstimateTokensOptions
): number {
  if (!messages || messages.length === 0) {
    return 0;
  }

  // Estimate tokens from content of each message
  const contentTokens = messages.reduce((sum, msg) => {
    const content = msg.content || '';
    return sum + estimateTokens(content, model, options);
  }, 0);

  // Add overhead for message structure (~4 tokens per message)
  const structureOverhead = messages.length * 4;

  return contentTokens + structureOverhead;
}

/**
 * Estimate tokens from an Anthropic messages request
 */
export function estimateAnthropicTokens(
  messages: Array<{ role?: string; content?: string | Array<unknown> }>,
  model: string,
  thinkingEnabled = false
): number {
  if (!messages || messages.length === 0) {
    return 0;
  }

  const contentTokens = messages.reduce((sum, msg) => {
    const content = msg.content;
    if (typeof content === 'string') {
      return sum + estimateTokens(content, model, { thinkingEnabled });
    }
    // For content blocks, estimate as string
    if (Array.isArray(content)) {
      return sum + estimateTokens(JSON.stringify(content), model, { thinkingEnabled });
    }
    return sum;
  }, 0);

  // Add overhead for message structure
  const structureOverhead = messages.length * 4;

  return contentTokens + structureOverhead;
}
