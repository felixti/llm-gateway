import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  CircuitState,
  getCircuitBreaker,
  recordSuccess,
  recordFailure,
  isRequestAllowed,
  getCircuitState,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../../src/services/circuit-breaker";

describe("Circuit Breaker Service", () => {
  const DEPLOYMENT = "test-deployment";

  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  afterEach(() => {
    resetAllCircuitBreakers();
  });

  describe("Initial State", () => {
    it("should start in CLOSED state", () => {
      const state = getCircuitState(DEPLOYMENT);
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
      expect(state.lastFailureTime).toBeNull();
      expect(state.nextAttemptTime).toBeNull();
    });

    it("should allow requests in CLOSED state", () => {
      expect(isRequestAllowed(DEPLOYMENT)).toBe(true);
    });
  });

  describe("CLOSED → OPEN Transition", () => {
    it("should transition to OPEN after 5 failures", () => {
      // Record 4 failures - should still be CLOSED
      for (let i = 0; i < 4; i++) {
        recordFailure(DEPLOYMENT);
      }
      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.CLOSED);
      expect(isRequestAllowed(DEPLOYMENT)).toBe(true);

      // 5th failure - should transition to OPEN
      recordFailure(DEPLOYMENT);
      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.OPEN);
      expect(isRequestAllowed(DEPLOYMENT)).toBe(false);
    });

    it("should increment failure count", () => {
      recordFailure(DEPLOYMENT);
      expect(getCircuitState(DEPLOYMENT).failureCount).toBe(1);

      recordFailure(DEPLOYMENT);
      expect(getCircuitState(DEPLOYMENT).failureCount).toBe(2);
    });

    it("should record last failure time", () => {
      const before = Date.now();
      recordFailure(DEPLOYMENT);
      const after = Date.now();

      const lastFailure = getCircuitState(DEPLOYMENT).lastFailureTime;
      expect(lastFailure).toBeGreaterThanOrEqual(before);
      expect(lastFailure).toBeLessThanOrEqual(after);
    });

    it("should set nextAttemptTime when opening", () => {
      recordFailure(DEPLOYMENT);
      recordFailure(DEPLOYMENT);
      recordFailure(DEPLOYMENT);
      recordFailure(DEPLOYMENT);
      recordFailure(DEPLOYMENT);

      const state = getCircuitState(DEPLOYMENT);
      expect(state.nextAttemptTime).not.toBeNull();
      expect(state.nextAttemptTime).toBeGreaterThan(Date.now());
    });
  });

  describe("OPEN → HALF_OPEN Transition", () => {
    it("should transition to HALF_OPEN after 30s timeout", async () => {
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        recordFailure(DEPLOYMENT);
      }
      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.OPEN);

      // Fast-forward time by manipulating nextAttemptTime
      const state = getCircuitBreaker(DEPLOYMENT);
      state.nextAttemptTime = Date.now() - 1; // Already expired

      // Now request should be allowed and transition to HALF_OPEN
      expect(isRequestAllowed(DEPLOYMENT)).toBe(true);
      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.HALF_OPEN);
    });

    it("should not transition before timeout", () => {
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        recordFailure(DEPLOYMENT);
      }

      // Set next attempt time to future
      const state = getCircuitBreaker(DEPLOYMENT);
      state.nextAttemptTime = Date.now() + 30_000;

      expect(isRequestAllowed(DEPLOYMENT)).toBe(false);
      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.OPEN);
    });
  });

  describe("HALF_OPEN → CLOSED Transition", () => {
    it("should transition to CLOSED on success in HALF_OPEN", () => {
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        recordFailure(DEPLOYMENT);
      }

      // Transition to HALF_OPEN
      const state = getCircuitBreaker(DEPLOYMENT);
      state.nextAttemptTime = Date.now() - 1;
      isRequestAllowed(DEPLOYMENT);

      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.HALF_OPEN);

      // Record success
      recordSuccess(DEPLOYMENT);

      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.CLOSED);
      expect(getCircuitState(DEPLOYMENT).failureCount).toBe(0);
    });

    it("should reset failure count on successful transition to CLOSED", () => {
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        recordFailure(DEPLOYMENT);
      }

      // Transition to HALF_OPEN
      const state = getCircuitBreaker(DEPLOYMENT);
      state.nextAttemptTime = Date.now() - 1;
      isRequestAllowed(DEPLOYMENT);

      // Record success
      recordSuccess(DEPLOYMENT);

      expect(getCircuitState(DEPLOYMENT).failureCount).toBe(0);
      expect(getCircuitState(DEPLOYMENT).nextAttemptTime).toBeNull();
    });
  });

  describe("HALF_OPEN → OPEN Transition", () => {
    it("should transition back to OPEN on failure in HALF_OPEN", () => {
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        recordFailure(DEPLOYMENT);
      }

      // Transition to HALF_OPEN
      const state = getCircuitBreaker(DEPLOYMENT);
      state.nextAttemptTime = Date.now() - 1;
      isRequestAllowed(DEPLOYMENT);

      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.HALF_OPEN);

      // Record failure in HALF_OPEN
      recordFailure(DEPLOYMENT);

      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.OPEN);
    });

    it("should reset nextAttemptTime when returning to OPEN", () => {
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        recordFailure(DEPLOYMENT);
      }

      // Transition to HALF_OPEN
      const state = getCircuitBreaker(DEPLOYMENT);
      state.nextAttemptTime = Date.now() - 1;
      isRequestAllowed(DEPLOYMENT);

      // Record failure in HALF_OPEN
      recordFailure(DEPLOYMENT);

      expect(getCircuitState(DEPLOYMENT).nextAttemptTime).toBeGreaterThan(
        Date.now()
      );
    });
  });

  describe("CLOSED state behavior", () => {
    it("should reset failure count on success in CLOSED", () => {
      recordFailure(DEPLOYMENT);
      recordFailure(DEPLOYMENT);
      expect(getCircuitState(DEPLOYMENT).failureCount).toBe(2);

      recordSuccess(DEPLOYMENT);

      expect(getCircuitState(DEPLOYMENT).failureCount).toBe(0);
    });

    it("should remain in CLOSED until threshold reached", () => {
      for (let i = 0; i < 4; i++) {
        expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.CLOSED);
        recordFailure(DEPLOYMENT);
      }

      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.CLOSED);
      recordFailure(DEPLOYMENT);
      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.OPEN);
    });
  });

  describe("Per-deployment isolation", () => {
    it("should maintain separate circuit breakers per deployment", () => {
      const DEPLOYMENT_A = "deployment-a";
      const DEPLOYMENT_B = "deployment-b";

      // Open circuit A
      for (let i = 0; i < 5; i++) {
        recordFailure(DEPLOYMENT_A);
      }

      expect(getCircuitState(DEPLOYMENT_A).state).toBe(CircuitState.OPEN);
      expect(getCircuitState(DEPLOYMENT_B).state).toBe(CircuitState.CLOSED);

      // B should still allow requests
      expect(isRequestAllowed(DEPLOYMENT_B)).toBe(true);
    });

    it("should allow independent state transitions", () => {
      const DEPLOYMENT_A = "deployment-a";
      const DEPLOYMENT_B = "deployment-b";

      // Open circuit A only
      for (let i = 0; i < 5; i++) {
        recordFailure(DEPLOYMENT_A);
      }

      // Transition A to HALF_OPEN
      const stateA = getCircuitBreaker(DEPLOYMENT_A);
      stateA.nextAttemptTime = Date.now() - 1;
      isRequestAllowed(DEPLOYMENT_A);

      // B should still be CLOSED
      expect(getCircuitState(DEPLOYMENT_B).state).toBe(CircuitState.CLOSED);

      // Success on A should close it
      recordSuccess(DEPLOYMENT_A);
      expect(getCircuitState(DEPLOYMENT_A).state).toBe(CircuitState.CLOSED);

      // B should still be CLOSED
      expect(getCircuitState(DEPLOYMENT_B).state).toBe(CircuitState.CLOSED);
    });
  });

  describe("resetCircuitBreaker", () => {
    it("should reset circuit to initial CLOSED state", () => {
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        recordFailure(DEPLOYMENT);
      }
      expect(getCircuitState(DEPLOYMENT).state).toBe(CircuitState.OPEN);

      resetCircuitBreaker(DEPLOYMENT);

      const state = getCircuitState(DEPLOYMENT);
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
      expect(state.lastFailureTime).toBeNull();
      expect(state.nextAttemptTime).toBeNull();
    });
  });

  describe("getCircuitBreaker", () => {
    it("should return same instance for same deployment", () => {
      const cb1 = getCircuitBreaker(DEPLOYMENT);
      const cb2 = getCircuitBreaker(DEPLOYMENT);
      expect(cb1).toBe(cb2);
    });

    it("should create new instance for different deployment", () => {
      const cb1 = getCircuitBreaker(DEPLOYMENT);
      const cb2 = getCircuitBreaker("other-deployment");
      expect(cb1).not.toBe(cb2);
    });
  });
});
