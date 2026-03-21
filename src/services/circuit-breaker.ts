/**
 * Circuit Breaker Service
 * State machine: closed → open → half-open → closed
 * Per-deployment instances stored in Map
 */

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

interface CircuitBreakerInstance {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
  nextAttemptTime: number | null;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT = 30_000; // 30 seconds

// Per-deployment circuit breakers stored in Map
const circuitBreakers = new Map<string, CircuitBreakerInstance>();

/**
 * Create a new circuit breaker instance for a deployment
 */
function createCircuitBreaker(): CircuitBreakerInstance {
  return {
    state: CircuitState.CLOSED,
    failureCount: 0,
    lastFailureTime: null,
    nextAttemptTime: null,
  };
}

/**
 * Get or create circuit breaker for a deployment
 */
export function getCircuitBreaker(deploymentName: string): CircuitBreakerInstance {
  if (!circuitBreakers.has(deploymentName)) {
    circuitBreakers.set(deploymentName, createCircuitBreaker());
  }
  return circuitBreakers.get(deploymentName)!;
}

/**
 * Record a successful request - reset failure count in CLOSED,
 * or transition HALF_OPEN → CLOSED
 */
export function recordSuccess(deploymentName: string): void {
  const cb = getCircuitBreaker(deploymentName);

  if (cb.state === CircuitState.HALF_OPEN) {
    // Success in half-open → closed
    cb.state = CircuitState.CLOSED;
    cb.failureCount = 0;
    cb.nextAttemptTime = null;
  } else if (cb.state === CircuitState.CLOSED) {
    // Reset failure count on success
    cb.failureCount = 0;
  }
}

/**
 * Record a failed request - increment count, potentially open circuit
 */
export function recordFailure(deploymentName: string): void {
  const cb = getCircuitBreaker(deploymentName);
  const now = Date.now();

  cb.failureCount++;
  cb.lastFailureTime = now;

  if (cb.state === CircuitState.CLOSED) {
    if (cb.failureCount >= DEFAULT_FAILURE_THRESHOLD) {
      // CLOSED → OPEN after threshold failures
      cb.state = CircuitState.OPEN;
      cb.nextAttemptTime = now + DEFAULT_RESET_TIMEOUT;
    }
  } else if (cb.state === CircuitState.HALF_OPEN) {
    // Failure in half-open → open immediately
    cb.state = CircuitState.OPEN;
    cb.nextAttemptTime = now + DEFAULT_RESET_TIMEOUT;
  }
}

/**
 * Check if a request can proceed (circuit allows it)
 */
export function isRequestAllowed(deploymentName: string): boolean {
  const cb = getCircuitBreaker(deploymentName);
  const now = Date.now();

  if (cb.state === CircuitState.CLOSED) {
    return true;
  }

  if (cb.state === CircuitState.OPEN) {
    // Check if reset timeout has elapsed
    if (cb.nextAttemptTime && now >= cb.nextAttemptTime) {
      // OPEN → HALF_OPEN after timeout
      cb.state = CircuitState.HALF_OPEN;
      return true;
    }
    return false;
  }

  if (cb.state === CircuitState.HALF_OPEN) {
    // Allow one request in half-open state
    return true;
  }

  return false;
}

/**
 * Get current state info for a deployment (for debugging/monitoring)
 */
export function getCircuitState(deploymentName: string): {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
  nextAttemptTime: number | null;
} {
  const cb = getCircuitBreaker(deploymentName);
  return {
    state: cb.state,
    failureCount: cb.failureCount,
    lastFailureTime: cb.lastFailureTime,
    nextAttemptTime: cb.nextAttemptTime,
  };
}

/**
 * Reset circuit breaker to initial state (for testing)
 */
export function resetCircuitBreaker(deploymentName: string): void {
  circuitBreakers.set(deploymentName, createCircuitBreaker());
}

/**
 * Reset all circuit breakers (for testing)
 */
export function resetAllCircuitBreakers(): void {
  circuitBreakers.clear();
}
