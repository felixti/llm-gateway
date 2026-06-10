const FALLBACK_CHARS_PER_TOKEN = 4;
const FALLBACK_OVERHEAD = 100;
const ANTHROPIC_MULTIPLIER = 1.1;

function estimateWithFallback(body: unknown): number {
  const text = JSON.stringify(body ?? {});
  if (text.length === 0) return 0;
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN) + FALLBACK_OVERHEAD;
}

export function estimateRequestTokens(
  body: unknown,
  family: 'openai-chat' | 'openai-responses' | 'anthropic-messages',
): number {
  const base = estimateWithFallback(body);
  if (family === 'anthropic-messages') {
    return Math.ceil(base * ANTHROPIC_MULTIPLIER);
  }
  return base;
}
