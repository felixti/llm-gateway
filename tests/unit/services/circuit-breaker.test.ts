import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  CircuitState,
  recordSuccess,
  recordFailure,
  isRequestAllowed,
  getCircuitState,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../../src/services/circuit-breaker";
import { redis } from "../../../src/db/redis";
import { MockRedis } from "../../integration/helpers/mock-redis";

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as Record<string, unknown>;
  r.get = mock.get.bind(mock);
  r.set = mock.set.bind(mock);
  r.setex = mock.setex.bind(mock);
  r.eval = mock.eval.bind(mock);
  r.hget = mock.hget.bind(mock);
  r.hgetall = mock.hgetall.bind(mock);
  r.hset = mock.hset.bind(mock);
  r.pipeline = mock.pipeline.bind(mock);
  r.incrbyfloat = mock.incrbyfloat.bind(mock);
  r.del = mock.del.bind(mock);
  r.ping = mock.ping.bind(mock);
  r.scan = mock.scan.bind(mock);
  r.ttl = mock.ttl.bind(mock);
}

describe("Circuit Breaker Service", () => {
  const DEPLOYMENT = "test-deployment";

  beforeEach(async () => {
    bindMockRedis(new MockRedis());
    await resetAllCircuitBreakers();
  });

  afterEach(async () => {
    await resetAllCircuitBreakers();
  });

  describe("Initial State", () => {
    it("should start in CLOSED state", async () => {
      const state = await getCircuitState(DEPLOYMENT);
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
      expect(state.lastFailureTime).toBeNull();
      expect(state.nextAttemptTime).toBeNull();
    });

    it("should allow requests in CLOSED state", async () => {
      expect(await isRequestAllowed(DEPLOYMENT)).toBe(true);
    });
  });

  describe("CLOSED → OPEN Transition", () => {
    it("should transition to OPEN after 5 failures", async () => {
      for (let i = 0; i < 4; i++) {
        await recordFailure(DEPLOYMENT);
      }
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.CLOSED);
      expect(await isRequestAllowed(DEPLOYMENT)).toBe(true);

      await recordFailure(DEPLOYMENT);
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.OPEN);
      expect(await isRequestAllowed(DEPLOYMENT)).toBe(false);
    });

    it("should increment failure count", async () => {
      await recordFailure(DEPLOYMENT);
      expect((await getCircuitState(DEPLOYMENT)).failureCount).toBe(1);

      await recordFailure(DEPLOYMENT);
      expect((await getCircuitState(DEPLOYMENT)).failureCount).toBe(2);
    });

    it("should record last failure time", async () => {
      const before = Date.now();
      await recordFailure(DEPLOYMENT);
      const after = Date.now();

      const lastFailure = (await getCircuitState(DEPLOYMENT)).lastFailureTime;
      expect(lastFailure).toBeGreaterThanOrEqual(before);
      expect(lastFailure).toBeLessThanOrEqual(after);
    });

    it("should set nextAttemptTime when opening", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }

      const state = await getCircuitState(DEPLOYMENT);
      expect(state.nextAttemptTime).not.toBeNull();
      expect(state.nextAttemptTime).toBeGreaterThan(Date.now());
    });
  });

  describe("OPEN → HALF_OPEN Transition", () => {
    it("should transition to HALF_OPEN after 30s timeout", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.OPEN);

      const key = `circuit:${DEPLOYMENT}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(key, 'nextAttemptTime', Date.now() - 1);

      expect(await isRequestAllowed(DEPLOYMENT)).toBe(true);
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.HALF_OPEN);
    });

    it("should not transition before timeout", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }

      const key = `circuit:${DEPLOYMENT}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(key, 'nextAttemptTime', Date.now() + 30_000);

      expect(await isRequestAllowed(DEPLOYMENT)).toBe(false);
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.OPEN);
    });
  });

  describe("HALF_OPEN → CLOSED Transition", () => {
    it("should transition to CLOSED on success in HALF_OPEN", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }

      const key = `circuit:${DEPLOYMENT}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(key, 'nextAttemptTime', Date.now() - 1);
      await isRequestAllowed(DEPLOYMENT);

      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.HALF_OPEN);

      await recordSuccess(DEPLOYMENT);

      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.CLOSED);
      expect((await getCircuitState(DEPLOYMENT)).failureCount).toBe(0);
    });

    it("should reset failure count on successful transition to CLOSED", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }

      const key = `circuit:${DEPLOYMENT}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(key, 'nextAttemptTime', Date.now() - 1);
      await isRequestAllowed(DEPLOYMENT);

      await recordSuccess(DEPLOYMENT);

      expect((await getCircuitState(DEPLOYMENT)).failureCount).toBe(0);
      expect((await getCircuitState(DEPLOYMENT)).nextAttemptTime).toBeNull();
    });
  });

  describe("HALF_OPEN → OPEN Transition", () => {
    it("should transition back to OPEN on failure in HALF_OPEN", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }

      const key = `circuit:${DEPLOYMENT}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(key, 'nextAttemptTime', Date.now() - 1);
      await isRequestAllowed(DEPLOYMENT);

      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.HALF_OPEN);

      await recordFailure(DEPLOYMENT);

      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.OPEN);
    });

    it("should reset nextAttemptTime when returning to OPEN", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }

      const key = `circuit:${DEPLOYMENT}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(key, 'nextAttemptTime', Date.now() - 1);
      await isRequestAllowed(DEPLOYMENT);

      await recordFailure(DEPLOYMENT);

      expect((await getCircuitState(DEPLOYMENT)).nextAttemptTime).toBeGreaterThan(
        Date.now()
      );
    });
  });

  describe("HALF_OPEN single-probe semantics", () => {
    it("should allow exactly one request in HALF_OPEN state (first allowed, second rejected)", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.OPEN);

      const key = `circuit:${DEPLOYMENT}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(key, 'nextAttemptTime', Date.now() - 1);

      const first = await isRequestAllowed(DEPLOYMENT);
      expect(first).toBe(true);

      const second = await isRequestAllowed(DEPLOYMENT);
      expect(second).toBe(false);
    });

    it("should close circuit after successful probe", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }

      const key = `circuit:${DEPLOYMENT}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(key, 'nextAttemptTime', Date.now() - 1);

      expect(await isRequestAllowed(DEPLOYMENT)).toBe(true);
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.HALF_OPEN);

      await recordSuccess(DEPLOYMENT);
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.CLOSED);

      expect(await isRequestAllowed(DEPLOYMENT)).toBe(true);
    });

    it("should re-open circuit when probe fails and allow next probe after timeout", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }

      const key = `circuit:${DEPLOYMENT}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(key, 'nextAttemptTime', Date.now() - 1);

      expect(await isRequestAllowed(DEPLOYMENT)).toBe(true);

      await recordFailure(DEPLOYMENT);
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.OPEN);

      expect(await isRequestAllowed(DEPLOYMENT)).toBe(false);

      await redis.hset(key, 'nextAttemptTime', Date.now() - 1);
      expect(await isRequestAllowed(DEPLOYMENT)).toBe(true);
    });

    it("should reject all requests after probe is in progress until probe completes", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }

      const key = `circuit:${DEPLOYMENT}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(key, 'nextAttemptTime', Date.now() - 1);

      expect(await isRequestAllowed(DEPLOYMENT)).toBe(true);

      expect(await isRequestAllowed(DEPLOYMENT)).toBe(false);
      expect(await isRequestAllowed(DEPLOYMENT)).toBe(false);
      expect(await isRequestAllowed(DEPLOYMENT)).toBe(false);

      await recordSuccess(DEPLOYMENT);
      expect(await isRequestAllowed(DEPLOYMENT)).toBe(true);
    });
  });

  describe("CLOSED state behavior", () => {
    it("should reset failure count on success in CLOSED", async () => {
      await recordFailure(DEPLOYMENT);
      await recordFailure(DEPLOYMENT);
      expect((await getCircuitState(DEPLOYMENT)).failureCount).toBe(2);

      await recordSuccess(DEPLOYMENT);

      expect((await getCircuitState(DEPLOYMENT)).failureCount).toBe(0);
    });

    it("should remain in CLOSED until threshold reached", async () => {
      for (let i = 0; i < 4; i++) {
        expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.CLOSED);
        await recordFailure(DEPLOYMENT);
      }

      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.CLOSED);
      await recordFailure(DEPLOYMENT);
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.OPEN);
    });
  });

  describe("Per-deployment isolation", () => {
    it("should maintain separate circuit breakers per deployment", async () => {
      const DEPLOYMENT_A = "deployment-a";
      const DEPLOYMENT_B = "deployment-b";

      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT_A);
      }

      expect((await getCircuitState(DEPLOYMENT_A)).state).toBe(CircuitState.OPEN);
      expect((await getCircuitState(DEPLOYMENT_B)).state).toBe(CircuitState.CLOSED);

      expect(await isRequestAllowed(DEPLOYMENT_B)).toBe(true);
    });

    it("should allow independent state transitions", async () => {
      const DEPLOYMENT_A = "deployment-a";
      const DEPLOYMENT_B = "deployment-b";

      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT_A);
      }

      const keyA = `circuit:${DEPLOYMENT_A}`;
      const { redis } = require("../../../src/db/redis");
      await redis.hset(keyA, 'nextAttemptTime', Date.now() - 1);
      await isRequestAllowed(DEPLOYMENT_A);

      expect((await getCircuitState(DEPLOYMENT_B)).state).toBe(CircuitState.CLOSED);

      await recordSuccess(DEPLOYMENT_A);
      expect((await getCircuitState(DEPLOYMENT_A)).state).toBe(CircuitState.CLOSED);

      expect((await getCircuitState(DEPLOYMENT_B)).state).toBe(CircuitState.CLOSED);
    });
  });

  describe("resetCircuitBreaker", () => {
    it("should reset circuit to initial CLOSED state", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailure(DEPLOYMENT);
      }
      expect((await getCircuitState(DEPLOYMENT)).state).toBe(CircuitState.OPEN);

      await resetCircuitBreaker(DEPLOYMENT);

      const state = await getCircuitState(DEPLOYMENT);
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
      expect(state.lastFailureTime).toBeNull();
      expect(state.nextAttemptTime).toBeNull();
    });
  });
});
