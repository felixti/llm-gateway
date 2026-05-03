import { z } from 'zod';

// Environment variable schema with Zod validation
const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Azure OpenAI
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_KEY: z.string().optional(),

  // Azure AI Foundry
  AZURE_AI_FOUNDRY_ENDPOINT: z.string().url().optional(),
  AZURE_AI_FOUNDRY_KEY: z.string().optional(),

  // Entra ID (for OAuth2 client credentials)
  AZURE_ENTRA_TENANT_ID: z.string().uuid().optional(),
  AZURE_ENTRA_CLIENT_ID: z.string().uuid().optional(),
  AZURE_ENTRA_CLIENT_SECRET: z.string().optional(),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z.string().optional(),

  // PostgreSQL
  DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://postgres:postgres@localhost:5432/llm_gateway'),

  // PAT Secret (for HMAC-SHA256 signing)
  PAT_SECRET: z.string().min(32),

  /** Optional shared secret for /admin when set (header X-Operator-Secret); defense in depth with admin PAT */
  ADMIN_OPERATOR_SECRET: z.string().min(16).optional(),

  // OpenTelemetry
  OTEL_EXPORTER_OTLP_GRPC_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('llm-gateway'),
  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),

  // Rate limiting defaults
  RATE_LIMIT_RPM: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_TPM: z.coerce.number().int().positive().default(100000),

  // Quota defaults
  QUOTA_RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  QUOTA_MULTIPLIER: z.coerce.number().positive().default(1.2),
  /** When true, pre-check budget overage adds X-Warning instead of 429 (reservation may still fail) */
  QUOTA_SOFT_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),

  // Health checks
  HEALTH_CHECK_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((v) => v === 'true'),
  HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  HEALTH_CHECK_DEPLOYMENTS_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((v) => v === 'true'),

  // Metrics
  METRICS_SCRAPE_BEARER: z.string().optional(),

  // OpenTelemetry (HTTP endpoint for metrics)
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

  // Security
  /** Comma-separated list of allowed CORS origins, or '*' for all origins */
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  /** Maximum request body size in bytes (default 10MB) */
  BODY_SIZE_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  /** Request timeout in milliseconds for non-streaming requests (default 30s) */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Graceful shutdown timeout in milliseconds (default 30s) */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

const TEST_PAT_SECRET = 'test-secret-that-is-at-least-32-chars!!';

type ParsedEnv = z.infer<typeof envSchema>;

function buildEnvInput(): Record<string, string | undefined> {
  const input = { ...process.env };

  if (process.env.NODE_ENV === 'test') {
    input.PAT_SECRET = input.PAT_SECRET || TEST_PAT_SECRET;

    if (input.ADMIN_OPERATOR_SECRET && input.ADMIN_OPERATOR_SECRET.length < 16) {
      input.ADMIN_OPERATOR_SECRET = undefined;
    }
  }

  return input;
}

function parseEnv(): ParsedEnv {
  const result = envSchema.safeParse(buildEnvInput());
  if (result.success) {
    return result.data;
  }

  const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
  throw new Error(`Invalid environment configuration:\n${errors.join('\n')}`);
}

// Validate and parse environment variables lazily. Tests re-parse so mutations remain isolated.
let _env: ParsedEnv | null = null;

function parseEnvOnce(): ParsedEnv {
  if (process.env.NODE_ENV === 'test') {
    return parseEnv();
  }

  if (_env === null) {
    _env = parseEnv();
  }
  return _env;
}

export function resetEnvForTests(): void {
  if (process.env.NODE_ENV === 'test') {
    _env = null;
  }
}

// Export typed config singleton - validated lazily
export const env = new Proxy({} as ParsedEnv, {
  get(_target, prop) {
    return parseEnvOnce()[prop as keyof ParsedEnv];
  },
});

// Type export for use in other modules
export type Env = ParsedEnv;
