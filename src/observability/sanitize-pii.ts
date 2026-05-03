/**
 * PII Sanitization
 * Extracted to avoid circular dependency between logger and pino-pii-transport
 */

// PII patterns for sanitization
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const TOKEN_PREFIX_PATTERN = /lg_[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+/g;
const API_KEY_PREFIX_PATTERN = /sk-[a-zA-Z0-9_]{20,}/g;
const CREDIT_CARD_PATTERN = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const PHONE_PATTERN = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const JWT_PAYLOAD_PATTERN = /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*/g;

// Sanitization replacements
const EMAIL_REPLACEMENT = 'u***@***.com';
const TOKEN_REPLACEMENT = 'lg_***_***.***';
const API_KEY_REPLACEMENT = 'sk-***';
const CREDIT_CARD_REPLACEMENT = '****-****-****-****';
const PHONE_REPLACEMENT = '***-***-****';
const SSN_REPLACEMENT = '***-**-****';
const JWT_PAYLOAD_REPLACEMENT = 'eyJ***.eyJ***';

/**
 * Sanitize PII from string values
 * Partial redaction preserves format for debugging while hiding sensitive data
 */
export function sanitizePII(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj
      .replace(EMAIL_PATTERN, EMAIL_REPLACEMENT)
      .replace(TOKEN_PREFIX_PATTERN, TOKEN_REPLACEMENT)
      .replace(API_KEY_PREFIX_PATTERN, API_KEY_REPLACEMENT)
      .replace(CREDIT_CARD_PATTERN, CREDIT_CARD_REPLACEMENT)
      .replace(PHONE_PATTERN, PHONE_REPLACEMENT)
      .replace(SSN_PATTERN, SSN_REPLACEMENT)
      .replace(JWT_PAYLOAD_PATTERN, JWT_PAYLOAD_REPLACEMENT);
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizePII);
  }

  if (obj !== null && typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizePII(value);
    }
    return sanitized;
  }

  return obj;
}
