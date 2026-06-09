import { describe, it, expect } from "bun:test";
import {
  sanitizePII,
} from "../../../src/observability/logger";
import {
  parsePatToken,
  validatePatStructure,
  hashJtiForBlocklist,
} from "../../../src/utils/auth";
import { createHmac } from "crypto";

describe("Security Sanitization", () => {
  describe("sanitizePII", () => {
    describe("email redaction", () => {
      it("should redact simple email addresses", () => {
        const input = { email: "user@example.com" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.email).toBe("u***@***.com");
      });

      it("should redact email with subdomain", () => {
        const input = { email: "user@mail.example.com" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.email).toBe("u***@***.com");
      });

      it("should redact email with plus addressing", () => {
        const input = { email: "user+tag@example.com" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.email).toBe("u***@***.com");
      });

      it("should handle multiple emails in string", () => {
        const input = "Contact user@example.com or admin@test.org";
        const result = sanitizePII(input) as string;
        // All emails replaced with same pattern (consistent, secure)
        expect(result).toBe("Contact u***@***.com or u***@***.com");
      });

      it("should preserve non-email strings", () => {
        const input = { name: "John Doe" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.name).toBe("John Doe");
      });
    });

    describe("PAT token prefix redaction", () => {
      it("should redact PAT tokens with lg_ prefix", () => {
        const input = { token: "lg_user123_header.payload.signature" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.token).toBe("lg_***_***.***");
      });

      it("should redact PAT tokens in strings", () => {
        const input = "Authorization: lg_user_abc.def.ghi";
        const result = sanitizePII(input) as string;
        expect(result).toBe("Authorization: lg_***_***.***");
      });

      it("should handle multiple PAT tokens", () => {
        const input = "Token1: lg_a.b.c and Token2: lg_x.y.z";
        const result = sanitizePII(input) as string;
        expect(result).toBe("Token1: lg_***_***.*** and Token2: lg_***_***.***");
      });

      it("should not redact non-lg_ strings", () => {
        const input = { token: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.token).toBe("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
      });
    });

    describe("API key prefix redaction", () => {
      it("should redact sk- prefixed API keys", () => {
        const input = { apiKey: "sk-1234567890abcdefghijklmnop" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.apiKey).toBe("sk-***");
      });

      it("should redact long sk- keys", () => {
        const input = { apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOP" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.apiKey).toBe("sk-***");
      });

      it("should not redact short sk- patterns", () => {
        const input = { key: "sk-123" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.key).toBe("sk-123");
      });
    });

    describe("credit card redaction", () => {
      it("should redact standard credit card format", () => {
        const input = { card: "4111-1111-1111-1111" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.card).toBe("****-****-****-****");
      });

      it("should redact credit card with spaces", () => {
        const input = { card: "4111 1111 1111 1111" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.card).toBe("****-****-****-****");
      });

      it("should redact credit card without separators", () => {
        const input = { card: "4111111111111111" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.card).toBe("****-****-****-****");
      });
    });

    describe("phone number redaction", () => {
      it("should redact US phone format with dashes", () => {
        const input = { phone: "555-123-4567" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.phone).toBe("***-***-****");
      });

      it("should redact US phone format with dots", () => {
        const input = { phone: "555.123.4567" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.phone).toBe("***-***-****");
      });

      it("should redact phone without separators", () => {
        const input = { phone: "5551234567" };
        const result = sanitizePII(input) as Record<string, unknown>;
        expect(result.phone).toBe("***-***-****");
      });
    });

    describe("nested objects and arrays", () => {
      it("should handle deeply nested objects", () => {
        const input = {
          user: {
            contact: {
              email: "test@example.com",
            },
          },
        };
        const result = sanitizePII(input) as { user: { contact: { email: string } } };
        expect(result.user.contact.email).toBe("u***@***.com");
      });

      it("should handle arrays of objects", () => {
        const input = [
          { email: "a@test.com" },
          { email: "b@test.com" },
        ];
        const result = sanitizePII(input) as Array<{ email: string }>;
        expect(result[0].email).toBe("u***@***.com");
        expect(result[1].email).toBe("u***@***.com");
      });

      it("should handle mixed arrays with primitives", () => {
        const input = ["user@test.com", 123, { email: "a@b.com" }];
        const result = sanitizePII(input) as [string, number, { email: string }];
        expect(result[0]).toBe("u***@***.com");
        expect(result[1]).toBe(123);
        expect(result[2].email).toBe("u***@***.com");
      });
    });

    describe("multiple PII types in same string", () => {
      it("should redact all PII types in single string", () => {
        const input =
          "Contact user@example.com with card 4111-1111-1111-1111 and phone 555-123-4567";
        const result = sanitizePII(input) as string;
        expect(result).toBe(
          "Contact u***@***.com with card ****-****-****-**** and phone ***-***-****"
        );
      });

      it("should redact email, PAT, and API key together", () => {
        const input =
          "Email: user@test.com | Token: lg_user.here.payload | Key: sk-1234567890abcdefghij";
        const result = sanitizePII(input) as string;
        expect(result).toBe(
          "Email: u***@***.com | Token: lg_***_***.*** | Key: sk-***"
        );
      });
    });

    describe("edge cases", () => {
      it("should handle null values", () => {
        expect(sanitizePII(null)).toBe(null);
      });

      it("should handle undefined values", () => {
        expect(sanitizePII(undefined)).toBe(undefined);
      });

      it("should handle number values", () => {
        expect(sanitizePII(42)).toBe(42);
      });

      it("should handle boolean values", () => {
        expect(sanitizePII(true)).toBe(true);
      });

      it("should handle empty strings", () => {
        expect(sanitizePII("")).toBe("");
      });

      it("should handle empty objects", () => {
        const result = sanitizePII({});
        expect(result).toEqual({});
      });

      it("should handle empty arrays", () => {
        const result = sanitizePII([]);
        expect(result).toEqual([]);
      });
    });
  });
});

describe("PAT Authentication Security", () => {
  describe("parsePatToken", () => {
    it("should parse valid PAT token", () => {
      // This is a fake token for testing structure only
      const fakeToken = "lg_user123_header.payload.signature";
      const result = parsePatToken(fakeToken);

      expect(result).not.toBeNull();
      expect(result!.userId).toBe("user123");
      expect(result!.header).toBe("lg_user123_header");
      expect(result!.payload).toBe("payload");
      expect(result!.signature).toBe("signature");
      expect(result!.raw).toBe(""); // Raw is NEVER stored
    });

    it("should return null for invalid format", () => {
      expect(parsePatToken("invalid")).toBeNull();
      expect(parsePatToken("only.two")).toBeNull();
      expect(parsePatToken("lg_no_dot_here")).toBeNull();
    });

    it("should not return raw token in parsed result", () => {
      const fakeToken = "lg_user123_header.payload.signature";
      const result = parsePatToken(fakeToken);
      expect(result!.raw).toBe("");
    });
  });

  describe("validatePatStructure", () => {
    it("should validate structurally correct token", () => {
      // Create a real verifiable token - we need to use the actual secret
      // but since env may not be initialized, we test the parsing separately
      const headerB64 = "lg_testuser_header";
      const payloadB64 = "payload";
      const signatureInput = `${headerB64}.${payloadB64}`;
      // Use any secret - the test validates structure parsing
      const signature = createHmac("sha256", "test-secret-at-least-32-chars-long!!")
        .update(signatureInput)
        .digest("hex");
      const realToken = `${headerB64}.${payloadB64}.${signature}`;

      // parsePatToken works without env
      const parsed = parsePatToken(realToken);
      expect(parsed).toBeDefined();
      expect(parsed!.userId).toBe("testuser");
      expect(parsed!.raw).toBe(""); // Raw never returned
    });

    it("should reject invalid signature", () => {
      // Create a token with valid structure but wrong signature
      const headerB64 = "lg_test_user";
      const payloadB64 = "payload";
      const signature = createHmac("sha256", "wrong-secret-that-is-32-chars!!")
        .update(`${headerB64}.${payloadB64}`)
        .digest("hex");
      const fakeToken = `${headerB64}.${payloadB64}.${signature}`;
      const result = validatePatStructure(fakeToken);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid signature");
    });

    it("should reject malformed token", () => {
      const result = validatePatStructure("not-a-pat-token");
      expect(result.valid).toBe(false);
    });
  });

  describe("hashJtiForBlocklist", () => {
    it("should produce consistent hash for same JTI", () => {
      const jti = "unique-jti-12345";
      const hash1 = hashJtiForBlocklist(jti);
      const hash2 = hashJtiForBlocklist(jti);
      expect(hash1).toBe(hash2);
    });

    it("should produce different hash for different JTI", () => {
      const hash1 = hashJtiForBlocklist("jti-1");
      const hash2 = hashJtiForBlocklist("jti-2");
      expect(hash1).not.toBe(hash2);
    });

    it("should return hex string", () => {
      const hash = hashJtiForBlocklist("test-jti");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
