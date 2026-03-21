# Functional Programming Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor LLM Gateway to use functional programming patterns - unified route handlers, Result types, pure functions, and composable utilities.

**Architecture:** 
- Create `utils/result.ts` with Result/Either types for explicit error handling
- Create `utils/functional.ts` with pipe/compose utilities  
- Create `routes/factories/request-handler.factory.ts` to unify 3 nearly identical route handlers
- Refactor middleware to use pure functions and Result types
- Replace mutable service state with immutable patterns

**Tech Stack:** TypeScript, Bun, Hono, Zod

---

## Phase 1: Functional Utilities Foundation

### Task 1.1: Create Result Types Module

**Files:**
- Create: `src/utils/result.ts`
- Test: `tests/unit/utils/result.test.ts`
- Reference: `src/utils/errors.ts` (existing error patterns)

- [ ] **Step 1: Create Result type with ok/error discriminated union**

```typescript
// src/utils/result.ts

/**
 * Result type for explicit error handling - Either monad in TypeScript
 * 
 * Usage:
 *   const result = safeParse(body, schema);
 *   if (!result.ok) return handleError(result.error);
 *   return processData(result.value);
 */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Create a successful Result
 */
export const ok = <T>(value: T): Result<T, never> => ({
  ok: true,
  value,
});

/**
 * Create a failed Result  
 */
export const err = <E>(error: E): Result<never, E> => ({
  ok: false,
  error,
});

/**
 * Map over the value inside a Result (functor)
 */
export const map = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> =>
  result.ok ? ok(fn(result.value)) : result;

/**
 * Chain Result values (monad flatMap/bind)
 */
export const flatMap = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> =>
  result.ok ? fn(result.value) : result;

/**
 * Get value or default if error
 */
export const getOrElse = <T, E>(
  result: Result<T, E>,
  defaultValue: T
): T =>
  result.ok ? result.value : defaultValue;

/**
 * Check if Result is ok
 */
export const isOk = <T, E>(result: Result<T, E>): result is Result<T, never> =>
  result.ok;

/**
 * Check if Result is error
 */
export const isErr = <T, E>(result: Result<T, E>): result is Result<never, E> =>
  !result.ok;
```

- [ ] **Step 2: Create Option type for nullable values**

```typescript
/**
 * Option type for representing optional values (Maybe monad)
 */
export type Option<T> = 
  | { readonly isSome: true; readonly value: T }
  | { readonly isNone: true };

export const some = <T>(value: T): Option<T> => ({ isSome: true, value });
export const none: Option<never> = { isNone: true };

export const mapOption = <T, U>(opt: Option<T>, fn: (value: T) => U): Option<U> =>
  opt.isSome ? some(fn(opt.value)) : none;

export const flatMapOption = <T, U>(opt: Option<T>, fn: (value: T) => Option<U>): Option<U> =>
  opt.isSome ? fn(opt.value) : none;

export const getOrElseOption = <T>(opt: Option<T>, defaultValue: T): T =>
  opt.isSome ? opt.value : defaultValue;
```

- [ ] **Step 3: Create tuple helpers**

```typescript
/**
 * Tuple types and helpers for common patterns
 */
export type Pair<A, B> = readonly [A, B];
export type Triple<A, B, C> = readonly [A, B, C];

export const tuple2 = <A, B>(a: A, b: B): Pair<A, B> => [a, b];
export const tuple3 = <A, B, C>(a: A, b: B, c: C): Triple<A, B, C> => [a, b, c];
```

- [ ] **Step 4: Write tests for Result types**

```typescript
// tests/unit/utils/result.test.ts

import { describe, expect, it } from 'bun:test';
import { ok, err, map, flatMap, isOk, isErr, getOrElse } from '@/utils/result';

describe('Result types', () => {
  describe('ok', () => {
    it('should create successful result', () => {
      const result = ok(42);
      expect(isOk(result)).toBe(true);
      expect(isErr(result)).toBe(false);
      expect(result.value).toBe(42);
    });
  });

  describe('err', () => {
    it('should create error result', () => {
      const result = err(new Error('fail'));
      expect(isErr(result)).toBe(true);
      expect(isOk(result)).toBe(false);
      expect(result.error.message).toBe('fail');
    });
  });

  describe('map', () => {
    it('should transform value in ok result', () => {
      const result = map(ok(21), (x) => x * 2);
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toBe(42);
    });

    it('should pass through error in err result', () => {
      const error = new Error('fail');
      const result = map(err(error), (x: number) => x * 2);
      expect(isErr(result)).toBe(true);
    });
  });

  describe('flatMap', () => {
    it('should chain successful results', () => {
      const result = flatMap(ok(21), (x) => ok(x * 2));
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value).toBe(42);
    });

    it('should short-circuit on error', () => {
      const result = flatMap(ok(21), () => err(new Error('fail')));
      expect(isErr(result)).toBe(true);
    });
  });

  describe('getOrElse', () => {
    it('should return value for ok result', () => {
      expect(getOrElse(ok(42), 0)).toBe(42);
    });

    it('should return default for error result', () => {
      expect(getOrElse(err(new Error('fail')), 0)).toBe(0);
    });
  });
});
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/unit/utils/result.test.ts`
Expected: 6 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/utils/result.ts tests/unit/utils/result.test.ts
git commit -m "feat(utils): add Result and Option types for explicit error handling"
```

---

### Task 1.2: Create Functional Helpers Module

**Files:**
- Create: `src/utils/functional.ts`
- Test: `tests/unit/utils/functional.test.ts`

- [ ] **Step 1: Create pipe utilities**

```typescript
// src/utils/functional.ts

/**
 * Function composition utilities for functional programming
 */

/**
 * Identity function - returns input unchanged
 */
export const identity = <T>(value: T): T => value;

/**
 * Compose two functions - applies fn1 then fn2
 * compose(f, g)(x) = g(f(x))
 */
export const compose2 = <A, B, C>(
  fn1: (a: A) => B,
  fn2: (b: B) => C
): ((a: A) => C) => (a) => fn2(fn1(a));

/**
 * Compose three functions
 */
export const compose3 = <A, B, C, D>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D
): ((a: A) => D) => (a) => fn3(fn2(fn1(a)));

/**
 * Pipe two functions - applies fn1 then fn2  
 * pipe(f, g)(x) = g(f(x)) but reads left-to-right
 */
export const pipe2 = <A, B, C>(
  fn1: (a: A) => B,
  fn2: (b: B) => C
): ((a: A) => C) => (a) => fn2(fn1(a));

/**
 * Pipe three functions
 */
export const pipe3 = <A, B, C, D>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D
): ((a: A) => D) => (a) => fn3(fn2(fn1(a)));

/**
 * Curry a binary function
 */
export const curry2 = <A, B, R>(fn: (a: A, b: B) => R) => 
  (a: A) => (b: B) => fn(a, b);

/**
 * Curry a ternary function
 */
export const curry3 = <A, B, C, R>(fn: (a: A, b: B, c: C) => R) =>
  (a: A) => (b: B) => (c: C) => fn(a, b, c);

/**
 * Flip arguments of a binary function
 */
export const flip = <A, B, C>(fn: (a: A, b: B) => C) =>
  (b: B, a: A) => fn(a, b);

/**
 * Constant function - always returns the same value
 */
export const constant = <T>(value: T) => () => value;

/**
 * Throttle a function - ensures it runs at most once per interval
 */
export const throttle = <T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) => {
  let lastCall = 0;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn(...args);
    }
  };
};
```

- [ ] **Step 2: Write tests**

```typescript
// tests/unit/utils/functional.test.ts

import { describe, expect, it } from 'bun:test';
import {
  identity,
  compose2,
  pipe2,
  curry2,
  flip,
  constant,
  getOrElse,
} from '@/utils/functional';

describe('Functional utilities', () => {
  describe('identity', () => {
    it('should return input unchanged', () => {
      expect(identity(42)).toBe(42);
      expect(identity('hello')).toBe('hello');
    });
  });

  describe('compose2', () => {
    it('should compose two functions', () => {
      const addOne = (x: number) => x + 1;
      const double = (x: number) => x * 2;
      const composed = compose2(addOne, double);
      expect(composed(5)).toBe(12); // (5 + 1) * 2
    });
  });

  describe('pipe2', () => {
    it('should pipe two functions left to right', () => {
      const addOne = (x: number) => x + 1;
      const double = (x: number) => x * 2;
      const piped = pipe2(addOne, double);
      expect(piped(5)).toBe(12); // (5 + 1) * 2
    });
  });

  describe('curry2', () => {
    it('should curry binary function', () => {
      const add = (a: number, b: number) => a + b;
      const curriedAdd = curry2(add);
      expect(curriedAdd(1)(2)).toBe(3);
    });
  });

  describe('flip', () => {
    it('should flip argument order', () => {
      const div = (a: number, b: number) => a / b;
      const flippedDiv = flip(div);
      expect(flippedDiv(2, 6)).toBe(3); // 6 / 2
    });
  });

  describe('constant', () => {
    it('should always return the same value', () => {
      const always42 = constant(42);
      expect(always42()).toBe(42);
      expect(always42()).toBe(42);
    });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/unit/utils/functional.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/utils/functional.ts tests/unit/utils/functional.test.ts
git commit -m "feat(utils): add functional composition helpers (pipe, compose, curry)"
```

---

## Phase 2: Unified Request Handler Factory

### Task 2.1: Create Request Handler Factory

**Files:**
- Create: `src/routes/factories/request-handler.factory.ts`
- Create: `src/routes/factories/types.ts`
- Modify: `src/routes/chat.routes.ts` (use factory)
- Modify: `src/routes/messages.routes.ts` (use factory)
- Modify: `src/routes/responses.routes.ts` (use factory)
- Test: `tests/unit/routes/factories/request-handler.factory.test.ts`

- [ ] **Step 1: Create factory types**

```typescript
// src/routes/factories/types.ts

import type { Context, Next } from 'hono';
import type { ZodSchema } from 'zod';
import type { DeploymentConfig } from '@/config/deployments';

/**
 * Protocol types for routing
 */
export type ProtocolType = 'openai' | 'anthropic';

/**
 * Result of parsing and validating request body
 */
export interface ValidatedRequest<T> {
  readonly body: T;
  readonly deployment: DeploymentConfig;
  readonly requestId: string;
  readonly reservationId: string;
}

/**
 * Dependencies for request handler factory
 */
export interface RequestHandlerDeps {
  /** Zod schema for body validation */
  schema: ZodSchema;
  /** Protocol type for error formatting */
  protocol: ProtocolType;
  /** Route path for error context */
  path: string;
  /** Streaming proxy function */
  proxyStreaming: ProxyStreamingFn;
  /** Non-streaming proxy function */
  proxyNonStreaming: ProxyNonStreamingFn;
  /** Extract model from validated body */
  getModel: (body: unknown) => string;
  /** Build upstream URL for deployment */
  buildUpstreamUrl: (deployment: DeploymentConfig) => string;
  /** Transform body for upstream (optional) */
  transformBody?: (body: unknown, deployment: DeploymentConfig) => Record<string, unknown>;
}

/**
 * Streaming proxy function signature
 */
export type ProxyStreamingFn = (
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  reservationId: string,
  requestId: string
) => Promise<Response>;

/**
 * Non-streaming proxy function signature  
 */
export type ProxyNonStreamingFn = (
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  reservationId: string
) => Promise<Response>;
```

- [ ] **Step 2: Create error response helper**

```typescript
// src/routes/factories/errors.ts

import type { Context } from 'hono';
import { errorForProtocol } from '@/utils/errors';
import { err, type Result } from '@/utils/result';

/**
 * Error types for request handling
 */
export type RequestError =
  | { type: 'invalid_json'; message: string }
  | { type: 'validation_error'; path: string; message: string }
  | { type: 'deployment_not_found'; model: string }
  | { type: 'circuit_open'; message: string }
  | { type: 'authentication_error'; message: string };

/**
 * Create error response from RequestError
 */
export function createRequestErrorResponse(
  c: Context,
  path: string,
  error: RequestError
): Response {
  const { status, code, message } = errorToStatusCode(error, path);
  const body = errorForProtocol(path, status, code, message);
  return c.json(body, status);
}

/**
 * Convert RequestError to HTTP status/code/message
 */
function errorToStatusCode(
  error: RequestError,
  path: string
): { status: number; code: string; message: string } {
  switch (error.type) {
    case 'invalid_json':
      return { status: 400, code: 'invalid_request', message: error.message };
    case 'validation_error':
      return { status: 400, code: 'invalid_request', message: `${error.path}: ${error.message}` };
    case 'deployment_not_found':
      return { status: 400, code: 'model_not_supported', message: `Unknown model: ${error.model}` };
    case 'circuit_open':
      return { status: 503, code: 'service_unavailable', message: 'Service temporarily unavailable, please retry' };
    case 'authentication_error':
      return { status: 401, code: 'authentication_error', message: error.message };
  }
}

/**
 * Wrap Zod validation result in Result type
 */
export function validateBody<T>(
  body: unknown,
  schema: ZodSchema
): Result<T, RequestError> {
  const parsed = schema.safeParse(body);
  
  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    return err({
      type: 'validation_error',
      path: firstError.path.join('.'),
      message: firstError.message,
    });
  }
  
  return ok(parsed.data as T);
}

/**
 * Wrap JSON parsing in Result type
 */
export function parseJsonBody(body: unknown): Result<Record<string, unknown>, RequestError> {
  if (typeof body !== 'object' || body === null) {
    return err({ type: 'invalid_json', message: 'Request body must be an object' });
  }
  return ok(body as Record<string, unknown>);
}
```

- [ ] **Step 3: Create the request handler factory**

```typescript
// src/routes/factories/request-handler.factory.ts

import type { Context, Next } from 'hono';
import { getDeploymentByAlias } from '@/config/deployments';
import { getAzureAuthManager } from '@/services/azure-auth';
import { isRequestAllowed } from '@/services/circuit-breaker';
import { err, ok, type Result } from '@/utils/result';
import { createRequestErrorResponse, parseJsonBody, validateBody, type RequestError } from './errors';
import type { RequestHandlerDeps, ValidatedRequest } from './types';

/**
 * Extract request context values from Hono context
 */
function extractRequestContext(c: Context): {
  requestId: string;
  reservationId: string;
  userId: string | undefined;
} {
  return {
    requestId: c.get('requestId') || '',
    reservationId: c.get('reservationId') || '',
    userId: c.get('userId'),
  };
}

/**
 * Get deployment for model, wrapped in Result
 */
function getDeployment(model: string): Result<import('@/config/deployments').DeploymentConfig, RequestError> {
  const deployment = getDeploymentByAlias(model);
  
  if (!deployment) {
    return err({ type: 'deployment_not_found', model });
  }
  
  return ok(deployment);
}

/**
 * Check circuit breaker, wrapped in Result
 */
function checkCircuitBreaker(deployment: import('@/config/deployments').DeploymentConfig): Result<void, RequestError> {
  if (!isRequestAllowed(deployment.name)) {
    return err({ type: 'circuit_open', message: 'Service temporarily unavailable' });
  }
  return ok(undefined);
}

/**
 * Create a unified request handler factory
 * Replaces ~170 lines of duplicated handler code per route
 */
export function createRequestHandler<T>(deps: RequestHandlerDeps) {
  return async function handleRequest(c: Context): Promise<Response> {
    const path = c.req.path;
    const { requestId, reservationId } = extractRequestContext(c);

    // 1. Parse JSON body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return createRequestErrorResponse(c, path, { type: 'invalid_json', message: 'Invalid JSON body' });
    }

    // 2. Validate body with Zod schema
    const validatedBody = validateBody(body, deps.schema);
    if (!validatedBody.ok) {
      return createRequestErrorResponse(c, path, validatedBody.error);
    }

    // 3. Get deployment
    const model = deps.getModel(validatedBody.value);
    const deployment = getDeployment(model);
    if (!deployment.ok) {
      return createRequestErrorResponse(c, path, deployment.error);
    }

    // 4. Check circuit breaker
    const circuitCheck = checkCircuitBreaker(deployment.value);
    if (!circuitCheck.ok) {
      return createRequestErrorResponse(c, path, circuitCheck.error);
    }

    // 5. Get auth headers (reuse singleton manager)
    const authManager = getAzureAuthManager();
    let authHeaders: Record<string, string>;
    try {
      authHeaders = await authManager.getAuthHeaders(deployment.value.name);
    } catch (authError) {
      return createRequestErrorResponse(c, path, {
        type: 'authentication_error',
        message: 'Failed to get authentication credentials',
      });
    }

    // 6. Build upstream URL and body
    const upstreamUrl = deps.buildUpstreamUrl(deployment.value);
    const upstreamBody = deps.transformBody
      ? deps.transformBody(validatedBody.value, deployment.value)
      : (validatedBody.value as Record<string, unknown>);

    // 7. Route to streaming or non-streaming proxy
    if (validatedBody.value.stream === true) {
      return deps.proxyStreaming(
        upstreamUrl,
        authHeaders,
        upstreamBody,
        deployment.value,
        reservationId,
        requestId
      );
    }

    return deps.proxyNonStreaming(
      upstreamUrl,
      authHeaders,
      upstreamBody,
      deployment.value,
      reservationId
    );
  };
}
```

- [ ] **Step 4: Create streaming response helpers**

```typescript
// src/routes/factories/streaming.ts

import type { Context } from 'hono';
import { errorForProtocol } from '@/utils/errors';

/**
 * Create a streaming error response
 */
export function createStreamingErrorResponse(
  c: Context,
  path: string,
  status: number,
  code: string,
  message: string
): Response {
  const error = errorForProtocol(path, status, code, message);
  return c.json(error, status);
}
```

- [ ] **Step 5: Create test helpers**

```typescript
// tests/unit/routes/factories/test-helpers.ts

import { z } from 'zod';
import type { RequestHandlerDeps } from '@/routes/factories/types';

// Test schema
export const testSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
  stream: z.boolean().optional(),
});

/**
 * Create mock dependencies for testing the factory
 */
export function createRequestHandlerDeps(): RequestHandlerDeps {
  return {
    schema: testSchema,
    protocol: 'openai',
    path: '/v1/chat/completions',
    proxyStreaming: vi.fn().mockResolvedValue(new Response()),
    proxyNonStreaming: vi.fn().mockResolvedValue(new Response()),
    getModel: (body) => (body as { model: string }).model,
    buildUpstreamUrl: () => 'http://test/upstream',
    transformBody: (body) => body as Record<string, unknown>,
  };
}
```

- [ ] **Step 6: Write factory tests**

```typescript
// tests/unit/routes/factories/request-handler.factory.test.ts

import { describe, expect, it, vi } from 'bun:test';
import { Hono } from 'hono';
import { createRequestHandler } from '@/routes/factories/request-handler.factory';
import { createRequestHandlerDeps } from '../factories/test-helpers';

// Mock dependencies
vi.mock('@/config/deployments', () => ({
  getDeploymentByAlias: vi.fn(),
}));

vi.mock('@/services/azure-auth', () => ({
  getAzureAuthManager: vi.fn(() => ({
    getAuthHeaders: vi.fn(() => Promise.resolve({ Authorization: 'Bearer test' })),
  })),
}));

vi.mock('@/services/circuit-breaker', () => ({
  isRequestAllowed: vi.fn(() => true),
}));

describe('Request Handler Factory', () => {
  const mockDeps = createRequestHandlerDeps();

  it('should create handler with correct dependencies', () => {
    const handler = createRequestHandler(mockDeps);
    expect(typeof handler).toBe('function');
  });

  it('should validate request body', async () => {
    const app = new Hono();
    const handler = createRequestHandler(mockDeps);
    app.post('/', handler);
    
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: 'body' }),
    });
    
    expect(res.status).toBe(400);
  });

  // ... more tests
});
```

- [ ] **Step 6: Refactor chat.routes.ts to use factory**

```typescript
// src/routes/chat.routes.ts (refactored)

import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '@/middleware/auth';
import { protocolGuardMiddleware } from '@/middleware/protocol-guard';
import { quotaMiddleware } from '@/middleware/quota';
import { rateLimitMiddleware } from '@/middleware/rate-limit';
import { buildRequestBody, buildUpstreamUrl, proxyNonStreamingChat, proxyStreamingChat } from '@/proxy/openai-chat.proxy';
import { createRequestHandler } from '@/routes/factories/request-handler.factory';

// Zod schema (unchanged)
const chatCompletionsBodySchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'function']),
    content: z.union([z.string(), z.null()]),
  })).min(1),
  stream: z.boolean().optional().default(false),
  // ... other fields
});

// Create handler factory with dependencies
const handleChatRequest = createRequestHandler({
  schema: chatCompletionsBodySchema,
  protocol: 'openai',
  path: '/v1/chat/completions',
  proxyStreaming: proxyStreamingChat,
  proxyNonStreaming: proxyNonStreamingChat,
  getModel: (body) => body.model,
  buildUpstreamUrl: (deployment) => buildUpstreamUrl(deployment, deployment.modelFamily),
  transformBody: (body, deployment) => buildRequestBody(body, deployment.modelFamily),
});

// Apply middleware and mount handler
export const chatRoutes = new Hono();
chatRoutes.use('*', authMiddleware);
chatRoutes.use('*', protocolGuardMiddleware);
chatRoutes.use('*', rateLimitMiddleware);
chatRoutes.use('*', quotaMiddleware);
chatRoutes.post('/', handleChatRequest);
```

- [ ] **Step 7: Repeat for messages.routes.ts and responses.routes.ts**

- [ ] **Step 8: Run typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add src/routes/factories/ src/routes/chat.routes.ts src/routes/messages.routes.ts src/routes/responses.routes.ts
git commit -m "refactor(routes): unify request handlers with factory pattern

- Create request handler factory to eliminate 3x code duplication
- Add Result types for explicit error handling
- Extract body parsing, validation, circuit breaker to reusable factory
- Refactor chat, messages, responses routes to use factory
- Remove ~250 lines of duplicate code"
```

---

## Phase 3: Middleware Refactoring

### Task 3.1: Refactor auth.ts to Use Result Types

**Files:**
- Modify: `src/middleware/auth.ts`

- [ ] **Step 1: Refactor auth middleware to use Result types**

```typescript
// src/middleware/auth.ts (refactored)

import type { Context, Next } from 'hono';
import { redis } from '@/db/redis';
import { type PatToken, hashJtiForBlocklist, validatePatStructure } from '@/utils/auth';
import { errorForProtocol } from '@/utils/errors';
import { ok, err, type Result } from '@/utils/result';

const HEADER_AUTHORIZATION = 'Authorization';
const BEARER_PREFIX = 'Bearer ';

// Context keys
export const USER_ID_KEY = 'userId';
export const SCOPE_KEY = 'scope';
export const JTI_KEY = 'jti';
export const PAT_TOKEN_KEY = 'patToken';

/**
 * Extract Bearer token - returns Result for explicit error handling
 */
function extractBearerToken(authHeader: string | undefined): Result<string, { type: 'missing_auth' }> {
  if (!authHeader) {
    return err({ type: 'missing_auth' });
  }
  
  if (!authHeader.startsWith(BEARER_PREFIX)) {
    return err({ type: 'missing_auth' });
  }
  
  return ok(authHeader.slice(BEARER_PREFIX.length));
}

/**
 * Parse JWT payload
 */
function parseJwtPayload(payloadB64: string): Result<{ jti: string; exp: number }, { type: 'invalid_payload' }> {
  try {
    const padded = payloadB64.padEnd(payloadB64.length + ((4 - (payloadB64.length % 4)) % 4), '=');
    const decoded = JSON.parse(atob(padded));
    return ok({
      jti: decoded.jti || '',
      exp: decoded.exp || 0,
    });
  } catch {
    return err({ type: 'invalid_payload' });
  }
}

/**
 * Check token expiry
 */
function checkExpiry(exp: number): Result<void, { type: 'token_expired' }> {
  const now = Math.floor(Date.now() / 1000);
  if (exp < now) {
    return err({ type: 'token_expired' });
  }
  return ok(undefined);
}

/**
 * Check Redis blocklist
 */
async function checkBlocklist(jti: string): Promise<Result<void, { type: 'token_revoked' }>> {
  const key = `blocklist:pat:${hashJtiForBlocklist(jti)}`;
  const result = await redis.get(key);
  
  if (result) {
    return err({ type: 'token_revoked' });
  }
  return ok(undefined);
}

/**
 * Auth middleware - refactored to use Result types
 */
export async function authMiddleware(c: Context, next: Next): Promise<void> {
  const path = c.req.path;
  
  // Extract token
  const tokenResult = extractBearerToken(c.req.header(HEADER_AUTHORIZATION));
  if (!tokenResult.ok) {
    const error = errorForProtocol(path, 401, 'authentication_error', 'Missing or invalid Authorization header');
    return c.json(error, 401);
  }

  // Validate token structure
  const validation = validatePatStructure(tokenResult.value);
  if (!validation.valid || !validation.token) {
    const error = errorForProtocol(path, 401, 'authentication_error', validation.error || 'Invalid PAT token');
    return c.json(error, 401);
  }

  // Parse payload
  const payloadResult = parseJwtPayload(validation.token.payload);
  if (!payloadResult.ok) {
    const error = errorForProtocol(path, 401, 'authentication_error', 'Invalid token payload');
    return c.json(error, 401);
  }

  // Check expiry
  const expiryResult = checkExpiry(payloadResult.value.exp);
  if (!expiryResult.ok) {
    const error = errorForProtocol(path, 401, 'authentication_error', 'Token has expired');
    return c.json(error, 401);
  }

  // Check blocklist
  const blocklistResult = await checkBlocklist(payloadResult.value.jti);
  if (!blocklistResult.ok) {
    const error = errorForProtocol(path, 401, 'authentication_error', 'Token has been revoked');
    return c.json(error, 401);
  }

  // Set context variables
  c.set(USER_ID_KEY, validation.token.userId);
  c.set(JTI_KEY, payloadResult.value.jti);
  c.set(SCOPE_KEY, 'all');
  c.set(PAT_TOKEN_KEY, validation.token);

  await next();
}
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/unit/middleware/auth.test.ts`
Expected: All pass (if tests exist)

- [ ] **Step 3: Commit**

```bash
git add src/middleware/auth.ts
git commit -m "refactor(auth): use Result types for explicit error handling"
```

---

### Task 3.2: Fix and Refactor quota.ts

**Files:**
- Modify: `src/middleware/quota.ts`

- [ ] **Step 1: Fix body reading and refactor to use Result**

```typescript
// src/middleware/quota.ts (refactored)

import type { Context, Next } from 'hono';
import { calculateEstimatedCost } from '@/services/pricing.service';
import { type QuotaReservation, checkAndReserve, getQuotaStatus, releaseReservation } from '@/services/quota.service';
import { errorForProtocol } from '@/utils/errors';
import { estimateAnthropicTokens, estimateMessagesTokens } from '@/utils/tokens';
import { err, ok, type Result } from '@/utils/result';

// Headers
const HEADER_QUOTA_REMAINING = 'X-Quota-Remaining';
const HEADER_QUOTA_RESERVED = 'X-Quota-Reserved';
const HEADER_WARNING = 'X-Warning';

// Context key for parsed body (avoids double-read)
const PARSED_BODY_KEY = 'parsedBody';

/**
 * Token estimation result
 */
interface TokenEstimate {
  promptTokens: number;
  thinkingEnabled: boolean;
  maxOutputTokens: number;
}

/**
 * Estimate request tokens - uses pre-parsed body to avoid double-read
 * @param body - Already-parsed request body
 * @param path - Request path for protocol detection
 * @param model - Model from validated request
 */
function estimateRequestTokens(
  body: Record<string, unknown>,
  path: string,
  model: string
): Result<TokenEstimate, { type: 'estimation_failed' }> {
  try {
    let promptTokens = 0;
    let thinkingEnabled = false;

    if (path.includes('/messages')) {
      const messages = (body.messages as Array<unknown>) || [];
      const thinking = body.thinking as { type?: string } | undefined;
      thinkingEnabled = thinking?.type === 'enabled';
      promptTokens = estimateAnthropicTokens(messages, model, thinkingEnabled);
    } else {
      const messages = (body.messages as Array<unknown>) || [];
      promptTokens = estimateMessagesTokens(messages, model);
    }

    // Extract max output tokens
    const maxOutputTokens =
      (body.max_completion_tokens as number) ||
      (body.max_tokens as number) ||
      1000;

    return ok({ promptTokens, thinkingEnabled, maxOutputTokens });
  } catch {
    return err({ type: 'estimation_failed' });
  }
}

/**
 * Quota middleware - refactored to read body ONCE
 */
export async function quotaMiddleware(c: Context, next: Next): Promise<void> {
  const userId = c.get('userId');
  const model = c.get('model') as string || '';

  // Skip if auth hasn't run
  if (!userId || !model) {
    await next();
    return;
  }

  // Read body ONCE and store in context for downstream use
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
    c.set(PARSED_BODY_KEY, body); // Store for potential downstream use
  } catch {
    const error = errorForProtocol(c.req.path, 400, 'invalid_request', 'Invalid JSON body');
    return c.json(error, 400);
  }

  // Get quota status
  const quotaStatus = await getQuotaStatus(userId);

  // Estimate tokens (using already-parsed body)
  const estimateResult = estimateRequestTokens(body, c.req.path, model);
  if (!estimateResult.ok) {
    const error = errorForProtocol(c.req.path, 500, 'internal_error', 'Failed to estimate tokens');
    return c.json(error, 500);
  }

  const { promptTokens, thinkingEnabled, maxOutputTokens } = estimateResult.value;

  const estimatedCost = calculateEstimatedCost(
    promptTokens,
    maxOutputTokens,
    model,
    thinkingEnabled ? Math.ceil(maxOutputTokens * 0.2) : 0
  );

  // Check budget
  const wouldExceedBudget =
    quotaStatus.spent_usd + quotaStatus.reserved_usd + estimatedCost.toNumber() >
    quotaStatus.monthly_budget_usd;

  if (wouldExceedBudget) {
    const error = errorForProtocol(
      c.req.path,
      429,
      'quota_exceeded',
      'Monthly quota exceeded. Please upgrade your plan or wait for reset.'
    );
    return c.json(error, 429);
  }

  // Reserve quota
  const reservation = await checkAndReserve(userId, estimatedCost);

  if (!reservation.allowed) {
    const error = errorForProtocol(
      c.req.path,
      429,
      'quota_exceeded',
      reservation.reason || 'Quota reservation failed'
    );
    return c.json(error, 429);
  }

  // Set context
  if (reservation.reservationId) {
    c.set('reservationId', reservation.reservationId);
  }
  if (reservation.estimatedCost) {
    c.set('estimatedCost', reservation.estimatedCost);
  }

  // Set headers
  c.header(HEADER_QUOTA_REMAINING, String(Math.max(0, Number(quotaStatus.remaining_usd.toFixed(6)))));
  if (reservation.reservationId) {
    c.header(HEADER_QUOTA_RESERVED, reservation.reservationId);
  }

  // Store cleanup
  const cleanup = async () => {
    if (reservation.reservationId) {
      await releaseReservation(reservation.reservationId);
    }
  };
  c.set('releaseQuota', cleanup);

  try {
    await next();
  } catch (error) {
    await cleanup();
    throw error;
  }
}
```

- [ ] **Step 2: Run tests**

Run: `bun run typecheck && bun test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/middleware/quota.ts
git commit -m "fix(quota): read body once instead of twice, use Result types"
```

---

## Phase 4: Service Layer Refactoring

### Task 4.1: Refactor azure-auth.ts to Use Functional Cache Pattern

**Files:**
- Modify: `src/services/azure-auth.ts`

- [ ] **Step 1: Refactor to use Map.replace for immutable cache updates**

```typescript
// src/services/azure-auth.ts (refactored)

import { type AzureAuthConfig, type DeploymentConfig, getDeploymentByAlias } from '../config/deployments';
import { err, ok, type Result } from '@/utils/result';

const TOKEN_REFRESH_BUFFER_SECONDS = 300;

interface JwtPayload {
  exp: number;
  iat: number;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

// Functional cache - Map.replace returns new Map (immutable pattern)
type TokenCache = Map<string, CachedToken>;

const createEmptyCache = (): TokenCache => new Map();

const getCachedToken = (cache: TokenCache, key: string): CachedToken | undefined =>
  cache.get(key);

const setCachedToken = (cache: TokenCache, key: string, token: CachedToken): TokenCache => {
  const newCache = new Map(cache);
  newCache.set(key, token);
  return newCache;
};

function decodeJwtExp(token: string): Result<number, { type: 'decode_failed' }> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return err({ type: 'decode_failed' });
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as JwtPayload;
    return ok(payload.exp ?? 0);
  } catch {
    return err({ type: 'decode_failed' });
  }
}

function needsProactiveRefresh(exp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return exp - now < TOKEN_REFRESH_BUFFER_SECONDS;
}

// Auth result type
type AuthResult = Result<Record<string, string>, { type: 'api_key_missing' } | { type: 'entra_config_missing' } | { type: 'token_fetch_failed'; message: string }>;

function getApiKeyHeaders(config: AzureAuthConfig): AuthResult {
  const { apiKey, keyHeader } = config;
  if (!apiKey) return err({ type: 'api_key_missing' });

  switch (keyHeader) {
    case 'Authorization':
      return ok({ Authorization: `Bearer ${apiKey}` });
    case 'x-api-key':
      return ok({ 'x-api-key': apiKey });
    default:
      return ok({ 'api-key': apiKey });
  }
}

async function fetchEntraToken(
  fetchFn: typeof fetch,
  tenantId: string,
  clientId: string,
  clientSecret: string,
  scope: string
): Promise<Result<string, { type: 'token_fetch_failed'; message: string }>> {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  try {
    const response = await fetchFn(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      return err({ type: 'token_fetch_failed', message: `${response.status} ${error}` });
    }

    const data = (await response.json()) as { access_token: string };
    return ok(data.access_token);
  } catch (e) {
    return err({ type: 'token_fetch_failed', message: String(e) });
  }
}

async function getEntraIdHeaders(
  fetchFn: typeof fetch,
  config: AzureAuthConfig,
  cache: TokenCache
): Promise<Result<{ headers: Record<string, string>; cache: TokenCache }, AuthResult>> {
  const { tenantId, clientId, clientSecret, scope } = config;

  if (!tenantId || !clientId || !clientSecret) {
    return err({ type: 'entra_config_missing' });
  }

  const cacheKey = `${tenantId}:${clientId}:${scope}`;
  const cached = getCachedToken(cache, cacheKey);

  if (cached && !needsProactiveRefresh(cached.expiresAt)) {
    return ok({
      headers: { Authorization: `Bearer ${cached.accessToken}` },
      cache,
    });
  }

  const tokenResult = await fetchEntraToken(fetchFn, tenantId, clientId, clientSecret, scope ?? '');
  if (!tokenResult.ok) {
    return err(tokenResult.error);
  }

  const expResult = decodeJwtExp(tokenResult.value);
  if (!expResult.ok) {
    return err({ type: 'token_fetch_failed', message: 'Failed to decode token expiry' });
  }

  const newCache = setCachedToken(cache, cacheKey, {
    accessToken: tokenResult.value,
    expiresAt: expResult.value,
  });

  return ok({
    headers: { Authorization: `Bearer ${tokenResult.value}` },
    cache: newCache,
  });
}

// Singleton cache (module-level state, but immutable updates)
let authManagerCache: TokenCache = createEmptyCache();
let authManagerFetch: typeof fetch = fetch;

export function getAzureAuthManager(): {
  getAuthHeaders: (deploymentName: string) => Promise<Result<Record<string, string>, AuthResult>>;
  clearCache: () => void;
} {
  return {
    async getAuthHeaders(deploymentName: string) {
      const deployment = getDeploymentByAlias(deploymentName);
      if (!deployment) {
        return err({ type: 'api_key_missing' }); // Reuse error type
      }

      const { authConfig } = deployment;

      if (authConfig.type === 'api-key') {
        return getApiKeyHeaders(authConfig);
      }

      const result = await getEntraIdHeaders(authManagerFetch, authConfig, authManagerCache);
      if (!result.ok) return err(result.error);
      
      // Update module-level cache with new immutable cache
      authManagerCache = result.value.cache;
      return ok(result.value.headers);
    },

    clearCache() {
      authManagerCache = createEmptyCache();
    },
  };
}

export function createAzureAuthManager(fetchFn?: typeof fetch): ReturnType<typeof getAzureAuthManager> {
  if (fetchFn) authManagerFetch = fetchFn;
  return getAzureAuthManager();
}
```

- [ ] **Step 2: Run tests**

Run: `bun run typecheck`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/services/azure-auth.ts
git commit -m "refactor(azure-auth): use immutable cache pattern with Map.replace"
```

---

### Task 4.2: Refactor circuit-breaker.ts with Immutable State

**Files:**
- Modify: `src/services/circuit-breaker.ts`

- [ ] **Step 1: Refactor with reducer pattern**

```typescript
// src/services/circuit-breaker.ts (refactored)

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
const DEFAULT_RESET_TIMEOUT = 30_000;

type CircuitBreakerAction =
  | { type: 'RECORD_SUCCESS' }
  | { type: 'RECORD_FAILURE' }
  | { type: 'TRY_RESET' };

/**
 * Pure reducer function for circuit breaker state
 */
export function circuitBreakerReducer(
  state: CircuitBreakerInstance,
  action: CircuitBreakerAction,
  now: number = Date.now()
): CircuitBreakerInstance {
  switch (action.type) {
    case 'RECORD_SUCCESS':
      if (state.state === CircuitState.HALF_OPEN) {
        return { ...state, state: CircuitState.CLOSED, failureCount: 0, nextAttemptTime: null };
      }
      return { ...state, failureCount: 0 };

    case 'RECORD_FAILURE':
      const newFailureCount = state.failureCount + 1;
      if (state.state === CircuitState.CLOSED) {
        if (newFailureCount >= DEFAULT_FAILURE_THRESHOLD) {
          return {
            ...state,
            state: CircuitState.OPEN,
            failureCount: newFailureCount,
            lastFailureTime: now,
            nextAttemptTime: now + DEFAULT_RESET_TIMEOUT,
          };
        }
      }
      if (state.state === CircuitState.HALF_OPEN) {
        return {
          ...state,
          state: CircuitState.OPEN,
          failureCount: newFailureCount,
          lastFailureTime: now,
          nextAttemptTime: now + DEFAULT_RESET_TIMEOUT,
        };
      }
      return { ...state, failureCount: newFailureCount, lastFailureTime: now };

    case 'TRY_RESET':
      if (state.state === CircuitState.OPEN && state.nextAttemptTime && now >= state.nextAttemptTime) {
        return { ...state, state: CircuitState.HALF_OPEN };
      }
      return state;

    default:
      return state;
  }
}

// Module-level store with immutable updates
const circuitBreakers = new Map<string, CircuitBreakerInstance>();

const createCircuitBreaker = (): CircuitBreakerInstance => ({
  state: CircuitState.CLOSED,
  failureCount: 0,
  lastFailureTime: null,
  nextAttemptTime: null,
});

export function getCircuitBreaker(deploymentName: string): CircuitBreakerInstance {
  if (!circuitBreakers.has(deploymentName)) {
    circuitBreakers.set(deploymentName, createCircuitBreaker());
  }
  return circuitBreakers.get(deploymentName)!;
}

function updateCircuitBreaker(deploymentName: string, updater: (cb: CircuitBreakerInstance) => CircuitBreakerInstance): void {
  const cb = getCircuitBreaker(deploymentName);
  const newCb = updater(cb);
  circuitBreakers.set(deploymentName, newCb);
}

export function recordSuccess(deploymentName: string): void {
  updateCircuitBreaker(deploymentName, (cb) => circuitBreakerReducer(cb, { type: 'RECORD_SUCCESS' }));
}

export function recordFailure(deploymentName: string): void {
  updateCircuitBreaker(deploymentName, (cb) => circuitBreakerReducer(cb, { type: 'RECORD_FAILURE' }));
}

export function isRequestAllowed(deploymentName: string): boolean {
  const cb = getCircuitBreaker(deploymentName);

  // Try reset if needed
  if (cb.state === CircuitState.OPEN) {
    updateCircuitBreaker(deploymentName, (state) => circuitBreakerReducer(state, { type: 'TRY_RESET' }));
  }

  const current = circuitBreakers.get(deploymentName)!;
  return current.state === CircuitState.CLOSED || current.state === CircuitState.HALF_OPEN;
}

export function getCircuitState(deploymentName: string): CircuitBreakerInstance {
  return { ...getCircuitBreaker(deploymentName) }; // Return copy
}

export function resetCircuitBreaker(deploymentName: string): void {
  circuitBreakers.set(deploymentName, createCircuitBreaker());
}

export function resetAllCircuitBreakers(): void {
  circuitBreakers.clear();
}
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/unit/services/circuit-breaker.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/services/circuit-breaker.ts
git commit -m "refactor(circuit-breaker): use reducer pattern for immutable state updates"
```

---

## Phase 5: Proxy Layer Refactoring

### Task 5.1: Extract Streaming Transformers

**Files:**
- Create: `src/utils/stream-transformers.ts`
- Modify: `src/proxy/openai-chat.proxy.ts`
- Modify: `src/proxy/anthropic.proxy.ts`

- [ ] **Step 1: Create composable stream transformers**

```typescript
// src/utils/stream-transformers.ts

import type { TokenUsage } from '@/services/pricing.service';

/**
 * Create a stream transformer that extracts usage from OpenAI SSE
 */
export function createUsageExtractingTransformer(
  onUsage: (usage: TokenUsage) => void
): TransformStreamDefaultController<Uint8Array>['transform'] {
  let usageExtracted = false;
  
  return (chunk, controller) => {
    if (!usageExtracted) {
      const text = new TextDecoder().decode(chunk);
      const usage = extractOpenAIUsage(text);
      if (usage) {
        usageExtracted = true;
        onUsage(usage);
      }
    }
    controller.enqueue(chunk);
  };
}

/**
 * Extract usage from OpenAI SSE chunk
 */
function extractOpenAIUsage(text: string): TokenUsage | null {
  try {
    // Look for final chunk with usage
    if (text.includes('[DONE]') || !text.includes('"usage"')) {
      return null;
    }
    
    // Parse SSE lines for usage
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        
        const parsed = JSON.parse(data);
        if (parsed.usage) {
          return {
            prompt_tokens: parsed.usage.prompt_tokens || 0,
            completion_tokens: parsed.usage.completion_tokens || 0,
            total_tokens: parsed.usage.total_tokens || 0,
          };
        }
      }
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Create a transformer that filters SSE events
 */
export function createSSEFilterTransformer(
  filter: (eventType: string, data: unknown) => boolean
): TransformStreamDefaultController<Uint8Array>['transform'] {
  return (chunk, controller) => {
    const text = new TextDecoder().decode(chunk);
    const lines = text.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        const eventType = line.slice(7).trim();
        // Pass through for now - full implementation would parse data line too
      }
    }
    
    controller.enqueue(chunk);
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/stream-transformers.ts
git commit -m "refactor(proxy): extract streaming transformers to reusable utilities"
```

---

## Summary

| Phase | Task | Files | Est. Lines |
|-------|------|-------|------------|
| 1 | Result types | src/utils/result.ts | +120 |
| 1 | Functional helpers | src/utils/functional.ts | +100 |
| 2 | Request factory | src/routes/factories/*.ts | +250 |
| 2 | Refactor routes | chat, messages, responses | -250 |
| 3 | Refactor auth | src/middleware/auth.ts | ~same |
| 3 | Refactor quota | src/middleware/quota.ts | ~same |
| 4 | Refactor azure-auth | src/services/azure-auth.ts | ~same |
| 4 | Refactor circuit-breaker | src/services/circuit-breaker.ts | ~same |
| 5 | Stream transformers | src/utils/stream-transformers.ts | +80 |
| **Net** | | | **~200 fewer LOC** |

---

## Next Steps After Implementation

1. Run full test suite: `bun test`
2. Run lint check: `bun run lint`
3. Run typecheck: `bun run typecheck`
4. Test with HTTP files: `http/chat-completions.http`, etc.
5. Push to feature branch and create PR
