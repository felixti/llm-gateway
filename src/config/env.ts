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
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // PostgreSQL
  DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://postgres:postgres@localhost:5432/llm_gateway'),

  // PAT Secret (for HMAC-SHA256 signing)
  PAT_SECRET: z.string().min(32).default('dev-secret-change-in-production'),

  // OpenTelemetry
  OTEL_EXPORTER_OTLP_GRPC_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('llm-gateway'),
  OTEL_ENABLED: z.boolean().default(false),

  // Rate limiting defaults
  RATE_LIMIT_RPM: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_TPM: z.coerce.number().int().positive().default(100000),

  // Quota defaults
  QUOTA_RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  QUOTA_MULTIPLIER: z.coerce.number().positive().default(1.2),
});

// Validate and parse environment variables lazily with fallback for tests
let _env: z.infer<typeof envSchema> | null = null;

function parseEnvOnce(): z.infer<typeof envSchema> {
  if (_env === null) {
    // In test environment, provide fallback values if validation would fail
    const testFallback = process.env.NODE_ENV === 'test' && !process.env.PAT_SECRET;

    try {
      const result = envSchema.safeParse(process.env);
      if (result.success) {
        _env = result.data;
      } else if (testFallback) {
        // Use defaults for tests
        _env = envSchema.parse({
          ...process.env,
          PAT_SECRET: 'test-secret-that-is-at-least-32-chars!!',
        });
      } else {
        const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
        throw new Error(`Invalid environment configuration:\n${errors.join('\n')}`);
      }
    } catch (e) {
      if (testFallback || process.env.NODE_ENV === 'test') {
        // Use defaults for tests
        _env = envSchema.parse({
          ...process.env,
          PAT_SECRET: 'test-secret-that-is-at-least-32-chars!!',
        });
      } else {
        throw e;
      }
    }
  }
  return _env;
}

// Export typed config singleton - validated lazily
export const env = new Proxy({} as z.infer<typeof envSchema>, {
  get(_target, prop) {
    return parseEnvOnce()[prop as keyof z.infer<typeof envSchema>];
  },
});

// Type export for use in other modules
export type Env = z.infer<typeof envSchema>;
