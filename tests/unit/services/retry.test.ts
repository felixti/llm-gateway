import { describe, it, expect } from "bun:test";
import {
  calculateBackoff,
  isNonRetryable,
  parseRetryAfterHeader,
  withRetry,
  type RetryOptions,
} from "../../../src/services/retry";

describe("Retry Service", () => {
  describe("calculateBackoff", () => {
    it("should return 1s base delay for first attempt", () => {
      const delay = calculateBackoff(1);
      // Base 1s = 1000ms, with jitter ±1s, so range [0, 2000]
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(2000);
    });

    it("should return 2s for second attempt", () => {
      const delay = calculateBackoff(2);
      // Base 2s = 2000ms, with jitter ±1s, so range [1000, 3000]
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(3000);
    });

    it("should return 4s for third attempt", () => {
      const delay = calculateBackoff(3);
      // Base 4s = 4000ms, with jitter ±1s, so range [3000, 5000]
      expect(delay).toBeGreaterThanOrEqual(3000);
      expect(delay).toBeLessThanOrEqual(5000);
    });

    it("should return 8s for fourth attempt", () => {
      const delay = calculateBackoff(4);
      // Base 8s = 8000ms, with jitter ±1s, so range [7000, 9000]
      expect(delay).toBeGreaterThanOrEqual(7000);
      expect(delay).toBeLessThanOrEqual(9000);
    });

    it("should cap at maxBackoffMs", () => {
      const delay = calculateBackoff(10, 5000); // Cap at 5s
      // 5s capped, with jitter ±1s, so range [4000, 6000] but capped at 5000 + jitter
      expect(delay).toBeGreaterThanOrEqual(4000);
      expect(delay).toBeLessThanOrEqual(6000);
    });

    it("should respect custom baseDelayMs", () => {
      const delay = calculateBackoff(1, 30_000, 500); // 500ms base
      // Base 500ms, with jitter ±1s, so range [0, 1500]
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1500);
    });

    it("should produce different values due to jitter", () => {
      // Run multiple times to verify jitter is working
      const delays: number[] = [];
      for (let i = 0; i < 10; i++) {
        delays.push(calculateBackoff(1, 30_000, 10_000)); // 10s base
      }
      // With ±1s jitter on 10s, we expect variation
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });
  });

  describe("Backoff timing sequence", () => {
    it("should follow exponential sequence: 1s, 2s, 4s, 8s", () => {
      // Test that the base values (without jitter) follow the exponential sequence
      // We sample multiple jittered values and check they center around expected values
      const samples = 100;

      const attempt1Delays: number[] = [];
      const attempt2Delays: number[] = [];
      const attempt3Delays: number[] = [];
      const attempt4Delays: number[] = [];

      for (let i = 0; i < samples; i++) {
        attempt1Delays.push(calculateBackoff(1));
        attempt2Delays.push(calculateBackoff(2));
        attempt3Delays.push(calculateBackoff(3));
        attempt4Delays.push(calculateBackoff(4));
      }

      // Average should be close to expected (1000, 2000, 4000, 8000)
      const avg1 = attempt1Delays.reduce((a, b) => a + b, 0) / samples;
      const avg2 = attempt2Delays.reduce((a, b) => a + b, 0) / samples;
      const avg3 = attempt3Delays.reduce((a, b) => a + b, 0) / samples;
      const avg4 = attempt4Delays.reduce((a, b) => a + b, 0) / samples;

      // Averages should be within jitter range of expected
      expect(avg1).toBeGreaterThan(0); // ~1000
      expect(avg1).toBeLessThan(2000);
      expect(avg2).toBeGreaterThan(1000); // ~2000
      expect(avg2).toBeLessThan(3000);
      expect(avg3).toBeGreaterThan(3000); // ~4000
      expect(avg3).toBeLessThan(5000);
      expect(avg4).toBeGreaterThan(7000); // ~8000
      expect(avg4).toBeLessThan(9000);
    });
  });

  describe("Jitter bounds", () => {
    it("should be within ±1s of base delay", () => {
      const samples = 50;

      for (let attempt = 1; attempt <= 4; attempt++) {
        const baseDelay = 1000 * Math.pow(2, attempt - 1);

        for (let i = 0; i < samples; i++) {
          const delay = calculateBackoff(attempt);
          // Delay should be within [base - 1000, base + 1000]
          expect(delay).toBeGreaterThanOrEqual(baseDelay - 1000);
          expect(delay).toBeLessThanOrEqual(baseDelay + 1000);
        }
      }
    });
  });

  describe("isNonRetryable", () => {
    it("should return true for 400", () => {
      expect(isNonRetryable(400)).toBe(true);
    });

    it("should return true for 401", () => {
      expect(isNonRetryable(401)).toBe(true);
    });

    it("should return true for 403", () => {
      expect(isNonRetryable(403)).toBe(true);
    });

    it("should return false for 429 (rate limit)", () => {
      expect(isNonRetryable(429)).toBe(false);
    });

    it("should return false for 500 (server error)", () => {
      expect(isNonRetryable(500)).toBe(false);
    });

    it("should return false for 502 (bad gateway)", () => {
      expect(isNonRetryable(502)).toBe(false);
    });

    it("should return false for 503 (service unavailable)", () => {
      expect(isNonRetryable(503)).toBe(false);
    });
  });

  describe("parseRetryAfterHeader", () => {
    it("should parse seconds", () => {
      const headers = new Headers({ "Retry-After": "30" });
      expect(parseRetryAfterHeader(headers)).toBe(30_000);
    });

    it("should parse HTTP date", () => {
      const futureDate = new Date(Date.now() + 60_000).toUTCString();
      const headers = new Headers({ "Retry-After": futureDate });
      const result = parseRetryAfterHeader(headers);
      expect(result).toBeGreaterThan(50_000); // ~60s
    });

    it("should return null for missing header", () => {
      const headers = new Headers();
      expect(parseRetryAfterHeader(headers)).toBeNull();
    });
  });

  describe("withRetry", () => {
    it("should return result on first success", async () => {
      const fn = async () => "success";
      const result = await withRetry(fn);
      expect(result).toBe("success");
    });

    it("should retry on transient failure and succeed", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Transient error");
        }
        return "success";
      };

      const result = await withRetry(fn, { maxRetries: 3 });
      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("should throw after max retries", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error("Persistent error");
      };

      await expect(withRetry(fn, { maxRetries: 2 })).rejects.toThrow(
        "Persistent error"
      );
      expect(attempts).toBe(3); // Initial + 2 retries
    });

    it("should skip retry for non-retryable 400", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const res = new Response(JSON.stringify({ error: "bad request" }), {
          status: 400,
        });
        throw res;
      };

      await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow();
      expect(attempts).toBe(1); // No retries
    });

    it("should skip retry for non-retryable 401", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const res = new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
        });
        throw res;
      };

      await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow();
      expect(attempts).toBe(1); // No retries
    });

    it("should skip retry for non-retryable 403", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const res = new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
        });
        throw res;
      };

      await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow();
      expect(attempts).toBe(1); // No retries
    });

    it("should retry on 429 (rate limit)", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 3) {
          const res = new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
          });
          throw res;
        }
        return "success";
      };

      const result = await withRetry(fn, { maxRetries: 3 });
      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("should retry on 500", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const res = new Response(JSON.stringify({ error: "server error" }), {
            status: 500,
          });
          throw res;
        }
        return "success";
      };

      const result = await withRetry(fn, { maxRetries: 3 });
      expect(result).toBe("success");
      expect(attempts).toBe(2);
    });

    it("should retry when fn resolves a 5xx Response", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          return new Response(JSON.stringify({ error: "bad gateway" }), {
            status: 502,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      const result = await withRetry(fn, { maxRetries: 3 });
      expect(result.status).toBe(200);
      expect(attempts).toBe(2);
    });

    it("should respect Retry-After header override", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts === 1) {
          const headers = new Headers();
          headers.set("Retry-After", "1"); // 1 second
          const res = new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            headers,
          });
          throw res;
        }
        return "success";
      };

      const start = Date.now();
      const result = await withRetry(fn, { maxRetries: 3 });
      const elapsed = Date.now() - start;

      expect(result).toBe("success");
      expect(attempts).toBe(2);
      // Should have waited at least 1s due to Retry-After header
      expect(elapsed).toBeGreaterThanOrEqual(900);
    });

    it("should use default options", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error("Transient error");
        }
        return "success";
      };

      const result = await withRetry(fn);
      expect(result).toBe("success");
      expect(attempts).toBe(2);
    });

    it("should handle custom maxRetries", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error("Always fails");
      };

      await expect(withRetry(fn, { maxRetries: 1 })).rejects.toThrow();
      expect(attempts).toBe(2); // Initial + 1 retry
    });
  });

  describe("AbortSignal integration", () => {
    it("throws AbortError without calling fn when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort(new DOMException("client gone", "AbortError"));

      let attempts = 0;
      const fn = async () => {
        attempts++;
        return "unexpected";
      };

      await expect(withRetry(fn, { signal: controller.signal })).rejects.toBeDefined();
      expect(attempts).toBe(0);
    });

    it("does not retry when fn throws an AbortError", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new DOMException("timed out", "AbortError");
      };

      await expect(withRetry(fn, { maxRetries: 3 })).rejects.toBeDefined();
      expect(attempts).toBe(1); // no retries after abort
    });

    it("short-circuits retry sleep when signal aborts mid-backoff", async () => {
      const controller = new AbortController();
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts === 1) {
          // Abort immediately so the post-failure sleep wakes early and the
          // loop exits via the aborted-check rather than waiting ~1s.
          setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 5);
          throw new Error("transient");
        }
        return "never";
      };

      const start = Date.now();
      await expect(
        withRetry(fn, { signal: controller.signal, baseDelayMs: 2000 })
      ).rejects.toBeDefined();
      const elapsed = Date.now() - start;

      // Would normally sleep ~1-2s before retrying; abort wakes it well before.
      expect(elapsed).toBeLessThan(1500);
    });
  });

  describe("Retry-After header override", () => {
    it("should use Retry-After instead of backoff calculation", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts === 1) {
          const headers = new Headers();
          headers.set("Retry-After", "2"); // 2 seconds
          const res = new Response("rate limited", {
            status: 429,
            headers,
          });
          throw res;
        }
        return "success";
      };

      const start = Date.now();
      await withRetry(fn, { maxRetries: 1 });
      const elapsed = Date.now() - start;

      // Should have waited ~2s (from Retry-After), not the usual backoff
      expect(elapsed).toBeGreaterThanOrEqual(1900);
      expect(elapsed).toBeLessThan(5000); // But not too long
    });
  });
});
