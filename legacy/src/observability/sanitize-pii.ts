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
// AWS access keys (AKIA...)
const AWS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
// Azure SAS tokens (sig=..., SharedAccessSignature)
const SAS_TOKEN_PATTERN = /sig=[a-zA-Z0-9%]{20,}/g;
const SAS_HEADER_PATTERN = /SharedAccessSignature sig=[a-zA-Z0-9%]{20,}/gi;
// Azure connection strings
const ACCOUNT_KEY_PATTERN = /AccountKey=[^;]+/gi;
const ENDPOINTS_PATTERN = /DefaultEndpointsProtocol=https?:\/\/[^;]+/gi;

// Sanitization replacements
const EMAIL_REPLACEMENT = 'u***@***.com';
const TOKEN_REPLACEMENT = 'lg_***_***.***';
const API_KEY_REPLACEMENT = 'sk-***';
const CREDIT_CARD_REPLACEMENT = '****-****-****-****';
const PHONE_REPLACEMENT = '***-***-****';
const SSN_REPLACEMENT = '***-**-****';
const JWT_PAYLOAD_REPLACEMENT = 'eyJ***.eyJ***';
const AWS_KEY_REPLACEMENT = 'AKIA************';
const SAS_TOKEN_REPLACEMENT = 'sig=[REDACTED]';
const SAS_HEADER_REPLACEMENT = 'SharedAccessSignature sig=[REDACTED]';
const ACCOUNT_KEY_REPLACEMENT = 'AccountKey=[REDACTED]';
const ENDPOINTS_REPLACEMENT = 'DefaultEndpointsProtocol=[REDACTED]';

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
      .replace(JWT_PAYLOAD_PATTERN, JWT_PAYLOAD_REPLACEMENT)
      .replace(AWS_KEY_PATTERN, AWS_KEY_REPLACEMENT)
      .replace(SAS_TOKEN_PATTERN, SAS_TOKEN_REPLACEMENT)
      .replace(SAS_HEADER_PATTERN, SAS_HEADER_REPLACEMENT)
      .replace(ACCOUNT_KEY_PATTERN, ACCOUNT_KEY_REPLACEMENT)
      .replace(ENDPOINTS_PATTERN, ENDPOINTS_REPLACEMENT);
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
