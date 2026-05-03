import { beforeEach, describe, expect, test, vi } from 'bun:test';
import { Decimal } from 'decimal.js';
import type { Context, Next } from 'hono';
import { ok } from '@/utils/result';

const mockCalculateEstimatedCost = vi.fn();
const mockCheckAndReserve = vi.fn();
const mockGetQuotaStatus = vi.fn();
const mockReleaseReservation = vi.fn();
const mockReconcileUsage = vi.fn();

vi.mock('../../../src/services/pricing.service', () => ({
  calculateEstimatedCost: (...args: unknown[]) => mockCalculateEstimatedCost(...args),
}));

vi.mock('../../../src/services/quota.service', () => ({
  checkAndReserve: (...args: unknown[]) => mockCheckAndReserve(...args),
  getQuotaStatus: (...args: unknown[]) => mockGetQuotaStatus(...args),
  releaseReservation: (...args: unknown[]) => mockReleaseReservation(...args),
  reconcileUsage: (...args: unknown[]) => mockReconcileUsage(...args),
}));

vi.mock('../../../src/observability/metrics', () => ({
  incrementQuotaExceeded429: vi.fn(),
  setQuotaRemainingRatio: vi.fn(),
}));

vi.mock('../../../src/observability/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function createContextWithoutParsedBody(): Context {
  const vars = new Map<string, unknown>([
    ['userId', 'user-1'],
    ['model', 'gpt-5.4'],
  ]);
  const context = {
    req: {
      path: '/v1/chat/completions',
      json: async () => {
        throw new Error('body should not be reparsed');
      },
    },
    get: (key: string) => vars.get(key),
    set: (key: string, value: unknown) => {
      vars.set(key, value);
    },
    header: () => undefined,
    json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  };

  return context as unknown as Context;
}

/**
 * Create a mock Hono context with all required fields for quota middleware.
 */
function createMockContext(overrides: {
  userId?: string;
  model?: string;
  path?: string;
  parsedBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}): { context: Context; vars: Map<string, unknown>; headers: Record<string, string> } {
  const vars = new Map<string, unknown>([
    ['userId', overrides.userId ?? 'user-1'],
    ['model', overrides.model ?? 'gpt-5.4'],
  ]);
  if (overrides.parsedBody) {
    vars.set('parsedBody', overrides.parsedBody);
  }
  const headers: Record<string, string> = { ...overrides.headers };

  const context = {
    req: {
      path: overrides.path ?? '/v1/chat/completions',
    },
    get: (key: string) => vars.get(key),
    set: (key: string, value: unknown) => {
      vars.set(key, value);
    },
    header: (name: string, value?: string) => {
      if (value !== undefined) {
        headers[name] = value;
      }
      return headers[name];
    },
    json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
    res: undefined as Response | undefined,
  };

  return { context: context as unknown as Context, vars, headers };
}

describe('quotaMiddleware — missing parsedBody', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.PAT_SECRET = 'test-secret-that-is-at-least-32-chars!!';
    vi.clearAllMocks();
  });

  test('returns invalid_request when parsedBody is missing after protocol guard', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');
    const next = vi.fn(async () => undefined) as Next;

    const response = await quotaMiddleware(createContextWithoutParsedBody(), next);

    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(400);
    const body = (await response!.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toBe('Invalid or missing request body');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('quotaMiddleware — soft limit over-budget', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.PAT_SECRET = 'test-secret-that-is-at-least-32-chars!!';
    process.env.QUOTA_SOFT_LIMIT_ENABLED = 'true';
    vi.clearAllMocks();
  });

  test('soft-limit over-budget calls next() and does NOT call checkAndReserve', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    mockGetQuotaStatus.mockResolvedValue(ok({
      monthly_budget_usd: 10,
      spent_usd: 9,
      reserved_usd: 0,
      remaining_usd: 1,
      reset_date: '2026-06-01T00:00:00.000Z',
      hard_limit: false,
    }));
    mockCalculateEstimatedCost.mockReturnValue(new Decimal(5));

    const { context, vars } = createMockContext({
      parsedBody: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 },
    });
    const next = vi.fn(async () => undefined) as Next;

    await quotaMiddleware(context, next);

    // Should call next() to allow the request through
    expect(next).toHaveBeenCalledTimes(1);
    // Should NOT call checkAndReserve (soft limit skips reservation)
    expect(mockCheckAndReserve).not.toHaveBeenCalled();
  });

  test('soft-limit over-budget sets releaseQuota to a no-op function', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    mockGetQuotaStatus.mockResolvedValue(ok({
      monthly_budget_usd: 10,
      spent_usd: 9,
      reserved_usd: 0,
      remaining_usd: 1,
      reset_date: '2026-06-01T00:00:00.000Z',
      hard_limit: false,
    }));
    mockCalculateEstimatedCost.mockReturnValue(new Decimal(5));

    const { context, vars } = createMockContext({
      parsedBody: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 },
    });
    const next = vi.fn(async () => undefined) as Next;

    await quotaMiddleware(context, next);

    // releaseQuota should be set to a no-op function
    const releaseQuota = vars.get('releaseQuota') as () => Promise<void>;
    expect(typeof releaseQuota).toBe('function');
    // Calling releaseQuota should not throw and should not call releaseReservation
    await releaseQuota();
    expect(mockReleaseReservation).not.toHaveBeenCalled();
  });

  test('soft-limit over-budget sets X-Warning header', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    mockGetQuotaStatus.mockResolvedValue(ok({
      monthly_budget_usd: 10,
      spent_usd: 9,
      reserved_usd: 0,
      remaining_usd: 1,
      reset_date: '2026-06-01T00:00:00.000Z',
      hard_limit: false,
    }));
    mockCalculateEstimatedCost.mockReturnValue(new Decimal(5));

    const { context, headers } = createMockContext({
      parsedBody: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 },
    });
    const next = vi.fn(async () => undefined) as Next;

    await quotaMiddleware(context, next);

    expect(headers['X-Warning']).toBe('Soft quota limit exceeded. Usage is being tracked.');
  });

  test('soft-limit over-budget sets X-Quota-Remaining to 0', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    mockGetQuotaStatus.mockResolvedValue(ok({
      monthly_budget_usd: 10,
      spent_usd: 9,
      reserved_usd: 0,
      remaining_usd: 1,
      reset_date: '2026-06-01T00:00:00.000Z',
      hard_limit: false,
    }));
    mockCalculateEstimatedCost.mockReturnValue(new Decimal(5));

    const { context, headers } = createMockContext({
      parsedBody: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 },
    });
    const next = vi.fn(async () => undefined) as Next;

    await quotaMiddleware(context, next);

    expect(headers['X-Quota-Remaining']).toBe('0');
  });

  test('soft-limit over-budget sets reservationId to empty string', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    mockGetQuotaStatus.mockResolvedValue(ok({
      monthly_budget_usd: 10,
      spent_usd: 9,
      reserved_usd: 0,
      remaining_usd: 1,
      reset_date: '2026-06-01T00:00:00.000Z',
      hard_limit: false,
    }));
    mockCalculateEstimatedCost.mockReturnValue(new Decimal(5));

    const { context, vars } = createMockContext({
      parsedBody: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 },
    });
    const next = vi.fn(async () => undefined) as Next;

    await quotaMiddleware(context, next);

    expect(vars.get('reservationId')).toBe('');
  });

  test('soft-limit over-budget sets estimatedCost for downstream visibility', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    mockGetQuotaStatus.mockResolvedValue(ok({
      monthly_budget_usd: 10,
      spent_usd: 9,
      reserved_usd: 0,
      remaining_usd: 1,
      reset_date: '2026-06-01T00:00:00.000Z',
      hard_limit: false,
    }));
    mockCalculateEstimatedCost.mockReturnValue(new Decimal(5));

    const { context, vars } = createMockContext({
      parsedBody: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 },
    });
    const next = vi.fn(async () => undefined) as Next;

    await quotaMiddleware(context, next);

    expect(vars.get('estimatedCost')).toBeInstanceOf(Decimal);
  });

  test('soft-limit under-budget still reserves normally', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    mockGetQuotaStatus.mockResolvedValue(ok({
      monthly_budget_usd: 100,
      spent_usd: 5,
      reserved_usd: 0,
      remaining_usd: 95,
      reset_date: '2026-06-01T00:00:00.000Z',
      hard_limit: false,
    }));
    mockCalculateEstimatedCost.mockReturnValue(new Decimal(0.5));
    mockCheckAndReserve.mockResolvedValue({
      allowed: true,
      reservationId: 'res_123',
      estimatedCost: new Decimal(0.5),
    });

    const { context, vars } = createMockContext({
      parsedBody: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 },
    });
    const next = vi.fn(async () => undefined) as Next;

    await quotaMiddleware(context, next);

    // Under budget: should call checkAndReserve normally
    expect(mockCheckAndReserve).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    // Should have a real reservationId
    expect(vars.get('reservationId')).toBe('res_123');
  });

  test('hard-limit over-budget still returns 429', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');

    // QUOTA_SOFT_LIMIT_ENABLED=false means isHardLimit=true when hard_limit=true
    process.env.QUOTA_SOFT_LIMIT_ENABLED = 'false';

    mockGetQuotaStatus.mockResolvedValue(ok({
      monthly_budget_usd: 10,
      spent_usd: 9,
      reserved_usd: 0,
      remaining_usd: 1,
      reset_date: '2026-06-01T00:00:00.000Z',
      hard_limit: true,
    }));
    mockCalculateEstimatedCost.mockReturnValue(new Decimal(5));

    const { context } = createMockContext({
      parsedBody: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 },
    });
    const next = vi.fn(async () => undefined) as Next;

    const response = await quotaMiddleware(context, next);

    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(429);
    expect(mockCheckAndReserve).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('quotaMiddleware — count_tokens', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.PAT_SECRET = 'test-secret-that-is-at-least-32-chars!!';
    vi.clearAllMocks();
  });

  test('skips reservation and calls next for /v1/messages/count_tokens', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');
    const next = vi.fn(async () => undefined) as Next;

    const { context } = createMockContext({
      path: '/v1/messages/count_tokens',
      parsedBody: {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    await quotaMiddleware(context, next);

    expect(mockCheckAndReserve).not.toHaveBeenCalled();
    expect(mockCalculateEstimatedCost).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('skips reservation when sub-app path is /count_tokens', async () => {
    const { quotaMiddleware } = await import('../../../src/middleware/quota');
    const next = vi.fn(async () => undefined) as Next;

    const { context } = createMockContext({
      path: '/count_tokens',
      parsedBody: {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    await quotaMiddleware(context, next);

    expect(mockCheckAndReserve).not.toHaveBeenCalled();
    expect(mockCalculateEstimatedCost).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
