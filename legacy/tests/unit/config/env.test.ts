import { describe, it, expect, vi } from "bun:test";
import { z } from "zod";
import { parseEnvForTests } from "../../../src/config/env";

// Mock the env module before importing it
vi.mock("../src/config/env", () => ({
  env: {
    NODE_ENV: "test",
    PORT: 3000,
    LOG_LEVEL: "info",
    AZURE_OPENAI_ENDPOINT: "https://test.openai.azure.com",
    AZURE_OPENAI_KEY: "test-key",
    AZURE_AI_FOUNDRY_ENDPOINT: "https://test.ai.azure.com",
    AZURE_AI_FOUNDRY_KEY: "test-key",
    REDIS_URL: "redis://localhost:6379",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/llm_gateway",
    PAT_SECRET: "test-secret-minimum-32-characters-long",
    OTEL_ENABLED: false,
    RATE_LIMIT_RPM: 100,
    RATE_LIMIT_TPM: 100000,
    QUOTA_RESERVATION_TTL_SECONDS: 300,
    QUOTA_MULTIPLIER: 1.2,
  },
}));

describe("Environment Configuration", () => {
  describe("Config Validation", () => {
    it("should validate required environment variables", () => {
      // Test with valid config - should not throw
      const validEnv = {
        NODE_ENV: "development",
        PORT: "3000",
        LOG_LEVEL: "info",
        REDIS_URL: "redis://localhost:6379",
        DATABASE_URL: "postgresql://localhost:5432/llm_gateway",
        PAT_SECRET: "test-secret-minimum-32-characters-long",
      };

      const schema = z.object({
        NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
        PORT: z.coerce.number().int().min(1).max(65535).default(3000),
        LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
        REDIS_URL: z.string().url().default("redis://localhost:6379"),
        DATABASE_URL: z.string().url().default("postgresql://localhost:5432/llm_gateway"),
        PAT_SECRET: z.string().min(32).default("dev-secret-change-in-production"),
      });

      const result = schema.safeParse(validEnv);
      expect(result.success).toBe(true);
    });

    it("should apply default values for optional variables", () => {
      // Test that defaults work for each field individually
      const schema = z.object({
        PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      });

      const result = schema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(3000);
      }
    });

    it("should reject invalid PORT values", () => {
      const schema = z.object({
        PORT: z.coerce.number().int().min(1).max(65535),
      });

      const invalidPorts = [0, -1, 70000, "abc"];
      for (const port of invalidPorts) {
        const result = schema.safeParse({ PORT: port });
        expect(result.success).toBe(false);
      }
    });

    it("should reject invalid LOG_LEVEL values", () => {
      const schema = z.object({
        LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
      });

      const result = schema.safeParse({ LOG_LEVEL: "invalid" });
      expect(result.success).toBe(false);
    });

    it("should reject PAT_SECRET shorter than 32 characters", () => {
      const schema = z.object({
        PAT_SECRET: z.string().min(32),
      });

      const result = schema.safeParse({ PAT_SECRET: "short" });
      expect(result.success).toBe(false);
    });

    it("should validate URLs correctly", () => {
      const schema = z.object({
        REDIS_URL: z.string().url(),
        DATABASE_URL: z.string().url(),
      });

      expect(schema.safeParse({ 
        REDIS_URL: "redis://localhost:6379",
        DATABASE_URL: "postgresql://localhost:5432/test"
      }).success).toBe(true);
      expect(schema.safeParse({ REDIS_URL: "invalid-url", DATABASE_URL: "postgresql://localhost:5432/test" }).success).toBe(false);
    });
  });

  describe("Production hardening", () => {
    const validProductionEnv = {
      NODE_ENV: "production",
      PAT_SECRET: "production-secret-minimum-32-characters",
      DATABASE_URL: "postgresql://gateway:secret@postgres.internal:5432/llm_gateway",
      REDIS_HOST: "redis.internal",
      CORS_ALLOWED_ORIGINS: "https://gateway.example.com,https://cli.example.com",
      AZURE_OPENAI_ENDPOINT: "https://prod-openai.openai.azure.com",
      AZURE_OPENAI_KEY: "prod-openai-key",
      AZURE_AI_FOUNDRY_ENDPOINT: "https://prod-foundry.ai.azure.com",
      AZURE_AI_FOUNDRY_KEY: "prod-foundry-key",
    };

    it("rejects wildcard CORS in production", () => {
      expect(() =>
        parseEnvForTests({
          ...validProductionEnv,
          CORS_ALLOWED_ORIGINS: "*",
        })
      ).toThrow(/CORS_ALLOWED_ORIGINS/);
    });

    it("requires explicit provider endpoints in production", () => {
      expect(() =>
        parseEnvForTests({
          ...validProductionEnv,
          AZURE_OPENAI_ENDPOINT: undefined,
        })
      ).toThrow(/AZURE_OPENAI_ENDPOINT/);

      expect(() =>
        parseEnvForTests({
          ...validProductionEnv,
          AZURE_AI_FOUNDRY_ENDPOINT: undefined,
        })
      ).toThrow(/AZURE_AI_FOUNDRY_ENDPOINT/);
    });

    it("requires provider credentials or Entra ID in production", () => {
      expect(() =>
        parseEnvForTests({
          ...validProductionEnv,
          AZURE_OPENAI_KEY: undefined,
          AZURE_AI_FOUNDRY_KEY: undefined,
        })
      ).toThrow(/AZURE_OPENAI_KEY|AZURE_AI_FOUNDRY_KEY|AZURE_ENTRA/);
    });

    it("accepts production config with explicit safe origins, endpoints, and provider keys", () => {
      const parsed = parseEnvForTests(validProductionEnv);

      expect(parsed.NODE_ENV).toBe("production");
      expect(parsed.CORS_ALLOWED_ORIGINS).toBe(
        "https://gateway.example.com,https://cli.example.com"
      );
      expect(parsed.AZURE_OPENAI_ENDPOINT).toBe("https://prod-openai.openai.azure.com");
      expect(parsed.AZURE_AI_FOUNDRY_ENDPOINT).toBe("https://prod-foundry.ai.azure.com");
    });

    it("accepts production config that uses REDIS_URL without REDIS_HOST", () => {
      const parsed = parseEnvForTests({
        ...validProductionEnv,
        REDIS_HOST: undefined,
        REDIS_URL: "redis://redis.internal:6379",
      });

      expect(parsed.REDIS_URL).toBe("redis://redis.internal:6379");
      expect(parsed.REDIS_HOST).toBe("localhost");
    });
  });
});
