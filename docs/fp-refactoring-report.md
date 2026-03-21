# Functional Programming Refactoring Report

**Date**: 2026-03-21  
**Project**: LLM Gateway  
**Status**: Draft - Awaiting Approval

---

## Executive Summary

This report analyzes the current codebase for functional programming improvement opportunities. The codebase has a solid foundation but exhibits several patterns that could benefit from FP principles: reduced repetition, clearer data flow, and safer error handling.

**Estimated Impact**:
- **Lines of code reduction**: ~15-20% in route handlers
- **Code duplication elimination**: 3 nearly identical route handlers
- **Error handling consistency**: Unified Result/Either patterns
- **Testability**: Improved through pure functions and dependency injection

---

## 1. Current Codebase Analysis

### 1.1 Route Handlers (Critical - High Priority)

**Files**: `src/routes/chat.routes.ts`, `src/routes/messages.routes.ts`, `src/routes/responses.routes.ts`

**Problem**: Near-identical structure repeated 3 times:

```
Route Handler Pattern (Repeated):
1. Parse JSON body
2. Validate with Zod schema
3. Get deployment by model alias
4. Check circuit breaker
5. Get auth headers (new AzureAuthManager instance each time!)
6. Build upstream URL
7. Call proxy (streaming or non-streaming)
```

**Lines of code**: ~157 + ~173 + ~187 = **517 lines** with massive duplication

**Key Issues**:
- `new AzureAuthManager()` instantiated on every request (line 130 in chat.routes.ts)
- Duplicate error handling for JSON parse, Zod validation, deployment lookup, circuit breaker
- Mixed concerns (validation + auth + routing logic)
- No composition - all logic in single handler function

```typescript
// Duplicate in ALL THREE files:
let body: unknown;
try {
  body = await c.req.json();
} catch {
  const error = errorForProtocol(c.req.path, 400, 'invalid_request', 'Invalid JSON body');
  c.status(400);
  return c.json(error);
}

const parsed = chatCompletionsBodySchema.safeParse(body);
if (!parsed.success) {
  const firstError = parsed.error.errors[0];
  const error = errorForProtocol(...)
  c.status(400);
  return c.json(error);
}
```

### 1.2 Middleware Layer (Medium Priority)

**File**: `src/middleware/auth.ts`

**Problem**: Repetitive early-return pattern with duplicate error creation:

```typescript
// 8 different early returns with identical structure
if (!rawToken) {
  const error = errorForProtocol(...);
  c.status(401);
  c.json(error);  // Note: missing 'return' here!
  return;         // Also has redundant return
}
```

**Issues**:
- Inconsistent `c.json()` vs `return c.json()` (line 73-74)
- Multiple similar error creation patterns
- Function does 4 things: extract, validate, check blocklist, check expiry

### 1.3 Middleware - Quota (Medium Priority)

**File**: `src/middleware/quota.ts`

**Problem**: Mixed concerns - reads body twice (lines 33 and 79):

```typescript
// First read at line 33
const body = await c.req.json().catch(() => ({}));

// Second read at line 79  
const body = await c.req.json().catch(() => ({}));
```

**Issues**:
- Body can only be read once from request - second call will fail silently
- Complex conditional logic for hard/soft limits
- Mutable cleanup function stored in context

### 1.4 Service Layer - AzureAuthManager (Medium Priority)

**File**: `src/services/azure-auth.ts`

**Problem**: Class with mutable state (tokenCache Map):

```typescript
export class AzureAuthManager {
  private tokenCache: Map<string, CachedToken>;  // Mutable state
  private fetchFn: typeof fetch;
  
  constructor(fetchFn: typeof fetch = fetch) {
    this.tokenCache = new Map();  // Side effect in constructor
    this.fetchFn = fetchFn;
  }
```

**Issues**:
- Singleton pattern via module-level `let authManagerInstance` - global mutable state
- Hard to test - caching behavior embedded in class
- Entangled concerns (caching + auth + fetching)

### 1.5 Service Layer - Circuit Breaker (Low-Medium Priority)

**File**: `src/services/circuit-breaker.ts`

**Problem**: Module-level mutable Map:

```typescript
// Global mutable state
const circuitBreakers = new Map<string, CircuitBreakerInstance>();

// Mutation scattered across functions
export function recordSuccess(deploymentName: string): void {
  const cb = getCircuitBreaker(deploymentName);
  if (cb.state === CircuitState.HALF_OPEN) {
    cb.state = CircuitState.CLOSED;  // Mutation
    cb.failureCount = 0;            // Mutation
    ...
  }
}
```

**Issues**:
- Global mutable state - can't have multiple independent instances
- Difficult to test without clearing state between tests
- Race conditions possible in concurrent scenarios

### 1.6 Utility Layer - Errors (Already Good)

**File**: `src/utils/errors.ts`

**Status**: ✅ Already functional - pure functions, no side effects

### 1.7 Proxy Handlers (Medium Priority)

**Files**: `src/proxy/openai-chat.proxy.ts`, `src/proxy/anthropic.proxy.ts`

**Problem**: Mixed concerns, imperative flow:

```typescript
// Lines 169-194: Streaming transformer with inline mutation
const transformer = createOpenAIStreamTransformer();
let usageExtracted = false;  // Mutable flag
handleStreamAbort(reservationId, releaseReservation);
```

**Issues**:
- Inline mutable state in stream processing
- Mixed quota management with proxy logic
- Hard to test stream transformations in isolation

---

## 2. Proposed Functional Patterns

### 2.1 Result/Either Type for Error Handling

Replace try/catch with explicit error types:

```typescript
// New types/utils/result.ts
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// Map over result
const map = <T, U, E>(result: Result<T, E>, fn: (t: T) => U): Result<U, E> =>
  result.ok ? ok(fn(result.value)) : result;

// Chain results
const flatMap = <T, U, E>(result: Result<T, E>, fn: (t: T) => Result<U, E>): Result<U, E> =>
  result.ok ? fn(result.value) : result;
```

### 2.2 Pipe/Compose for Data Transformation

Replace nested function calls with composable pipes:

```typescript
// New utils/functional.ts
export const pipe = <T>(value: T): T => value;
export const pipe2 = <A, B, R>(fn1: (a: A) => B, fn2: (b: B) => R) => (a: A) => fn2(fn1(a));
export const compose = <T>(...fns: Array<(t: T) => T>) => (value: T) => fns.reduce((v, f) => f(v), value);
```

### 2.3 Request Handler Factory

Extract common pattern into reusable factory:

```typescript
// New routes/factories/request-handler.ts
interface HandlerDeps {
  schema: ZodSchema;
  proxyFn: ProxyFunction;
  protocolPath: string;
}

export const createRequestHandler = (deps: HandlerDeps) => async (c: Context) => {
  // Unified flow:
  // 1. parseBody(c) → Result<unknown, Error>
  // 2. validateBody(body, schema) → Result<ValidBody, ZodError>
  // 3. getDeployment(model) → Result<Deployment, DeploymentError>
  // 4. checkCircuitBreaker(deployment) → Result<void, CircuitOpenError>
  // 5. getAuthHeaders(deployment) → Result<Headers, AuthError>
  // 6. proxyFn(upstreamUrl, headers, body) → Response
};
```

### 2.4 Pure Circuit Breaker with Immutable Updates

```typescript
// Refactored with immer-style immutable updates
interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  lastFailureTime: number | null;
  nextAttemptTime: number | null;
}

type CircuitBreakerAction =
  | { type: 'RECORD_SUCCESS' }
  | { type: 'RECORD_FAILURE' }
  | { type: 'TRY_RESET' };

export const circuitBreakerReducer = (state: CircuitBreakerState, action: CircuitBreakerAction): CircuitBreakerState => {
  switch (action.type) {
    case 'RECORD_SUCCESS':
      return state.state === 'HALF_OPEN'
        ? { ...state, state: 'CLOSED', failureCount: 0 }
        : { ...state, failureCount: 0 };
    case 'RECORD_FAILURE':
      return {
        ...state,
        failureCount: state.failureCount + 1,
        lastFailureTime: Date.now(),
        state: state.failureCount + 1 >= 5 ? 'OPEN' : state.state,
      };
    ...
  }
};
```

---

## 3. Recommended Refactoring Plan

### Phase 1: Utilities Foundation (No behavioral changes)
1. Create `utils/result.ts` - Result/Either types
2. Create `utils/functional.ts` - pipe, compose, curry helpers
3. Update `utils/errors.ts` to use Result types

### Phase 2: Route Handler Unification (High impact, low risk)
4. Create `routes/factories/request-handler.factory.ts`
5. Create `routes/factories/validators.ts` - shared validation logic
6. Refactor `chat.routes.ts` to use factory
7. Refactor `messages.routes.ts` to use factory
8. Refactor `responses.routes.ts` to use factory
9. Delete duplicated code patterns

### Phase 3: Middleware Refactoring
10. Refactor `auth.ts` - extract to pure functions, use Result types
11. Fix `quota.ts` - single body read, use Result types
12. Extract common middleware utilities

### Phase 4: Service Layer
13. Refactor `azure-auth.ts` - functional cache with Map.replace pattern
14. Refactor `circuit-breaker.ts` - state machine with reducer pattern
15. Make services more testable with dependency injection

### Phase 5: Proxy Layer
16. Extract streaming transformers to `utils/stream.ts`
17. Separate quota concerns from proxy logic
18. Make transformers pure/composable

---

## 4. Files Summary

| File | Current LOC | Estimated After FP | Reduction |
|------|-------------|-------------------|-----------|
| chat.routes.ts | 157 | ~80 | 49% |
| messages.routes.ts | 173 | ~80 | 54% |
| responses.routes.ts | 187 | ~80 | 57% |
| auth.ts | 140 | ~100 | 29% |
| quota.ts | 183 | ~120 | 34% |
| azure-auth.ts | 211 | ~180 | 15% |
| circuit-breaker.ts | 148 | ~130 | 12% |
| **Total** | **1199** | **~770** | **~36%** |

---

## 5. Testing Strategy

### 5.1 Pure Functions
- All refactored utility functions are easily unit testable
- No mocking required for pure transformations

### 5.2 Integration Points
- Route factory can be tested with mock Hono context
- Middleware can be tested in isolation with mock next()

### 5.3 Existing Tests
- All 253 existing tests should continue to pass
- Add new tests for Result types and functional utilities

---

## 6. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking existing API | Low | High | No API contract changes, only internal refactoring |
| Performance regression | Low | Medium | FP patterns don't add overhead with modern JS engines |
| Test coverage gaps | Medium | Medium | Add tests for new utility functions |
| Over-engineering | Medium | Low | Start with simple patterns, don't force FP where OOP is clearer |

---

## 7. Next Steps

1. **Approve this report** - User reviews and approves the plan
2. **Create detailed spec** - Write `docs/fp-refactoring-spec.md` with exact implementation details
3. **Implementation** - Follow phases outlined above
4. **Validation** - Ensure all tests pass, lint clean, typecheck clean

---

*Report generated for LLM Gateway functional programming refactoring initiative*
