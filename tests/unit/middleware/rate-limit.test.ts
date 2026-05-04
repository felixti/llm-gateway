import { beforeEach, describe, expect, test, vi } from 'bun:test';
import type { Context, Next } from 'hono';

const mockRedisEval = vi.fn();
const evalCalls: unknown[][] = [];

vi.mock('../../../src/db/redis', () => ({
  redis: {
    eval: (...args: unknown[]) => mockRedisEval(...args),
  },
}));

function createContext(parsedBody: Record<string, unknown>): Context {
  const vars = new Map<string, unknown>([
    ['userId', 'user-1'],
    ['parsedBody', parsedBody],
  ]);
  const headers = new Map<string, string>();
  const context = {
    req: { path: '/v1/chat/completions' },
    get: (key: string) => vars.get(key),
    set: (key: string, value: unknown) => {
      vars.set(key, value);
    },
    header: (name: string, value: string) => {
      headers.set(name, value);
    },
    json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  };

  return context as unknown as Context;
}

function createContextForPath(parsedBody: Record<string, unknown>, path: string): Context {
  const context = createContext(parsedBody) as unknown as {
    req: { path: string };
  };
  context.req.path = path;
  return context as unknown as Context;
}

describe('rateLimitMiddleware', () => {
  beforeEach(() => {
    evalCalls.length = 0;
    mockRedisEval.mockReset();
    mockRedisEval.mockImplementation(async (...args: unknown[]) => {
      evalCalls.push(args);
      return [1, 1];
    });
  });

  test('Infinity skips token limit check (no TPM eval)', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContext({ model: 'gpt-5.4', max_tokens: Infinity }),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(evalCalls).toHaveLength(1); // only RPM, no TPM
  });

  test('NaN skips token limit check (no TPM eval)', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContext({ model: 'gpt-5.4', max_tokens: NaN }),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(evalCalls).toHaveLength(1);
  });

  test('negative skips token limit check (no TPM eval)', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContext({ model: 'gpt-5.4', max_tokens: -5 }),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(evalCalls).toHaveLength(1);
  });

  test('zero skips token limit check (no TPM eval)', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContext({ model: 'gpt-5.4', max_completion_tokens: 0 }),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(evalCalls).toHaveLength(1);
  });

  test('uses max_completion_tokens for token-per-minute limiting', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContext({ model: 'gpt-5.4', max_completion_tokens: 456 }),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(evalCalls).toHaveLength(2);
    expect(evalCalls[1][2]).toBe('ratelimit:tpm:user-1');
    expect(evalCalls[1][5]).toBe(456);
  });

  test('max_completion_tokens takes precedence over max_tokens', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContext({ model: 'gpt-5.4', max_completion_tokens: 200, max_tokens: 100 }),
      next
    );

    expect(evalCalls[1][5]).toBe(200);
  });

  test('falls back to max_tokens when max_completion_tokens not set', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContext({ model: 'gpt-5.4', max_tokens: 300 }),
      next
    );

    expect(evalCalls[1][5]).toBe(300);
  });

  test('falls back to max_tokens when max_completion_tokens = 0', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContext({ model: 'gpt-5.4', max_completion_tokens: 0, max_tokens: 150 }),
      next
    );

    expect(evalCalls[1][5]).toBe(150);
  });

  test('counts Chat Completions prompt messages toward token-per-minute limiting', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContext({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'x'.repeat(400) }],
        max_completion_tokens: 20,
      }),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(evalCalls).toHaveLength(2);
    expect(evalCalls[1][5]).toBeGreaterThan(20);
  });

  test('counts Responses API string input toward token-per-minute limiting', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContextForPath(
        { model: 'gpt-5.4', input: 'This prompt must count toward TPM.', max_tokens: 20 },
        '/v1/responses'
      ),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(evalCalls).toHaveLength(2);
    expect(evalCalls[1][5]).toBeGreaterThan(20);
  });

  test('counts Anthropic content block text toward token-per-minute limiting', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContextForPath(
        {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize this long input.' }] }],
          max_tokens: 25,
        },
        '/v1/messages'
      ),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(evalCalls).toHaveLength(2);
    expect(evalCalls[1][5]).toBeGreaterThan(25);
  });

  test('counts Anthropic messages toward TPM on mounted /count_tokens path', async () => {
    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    await rateLimitMiddleware(
      createContextForPath(
        {
          model: 'claude-opus-4-6',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize this long input.' }] }],
        },
        '/count_tokens'
      ),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(evalCalls).toHaveLength(2);
    expect(evalCalls[1][5]).toBeGreaterThan(0);
  });

  test('fail-closed: Redis error on RPM check returns 429', async () => {
    mockRedisEval.mockReset();
    mockRedisEval.mockImplementation(async (...args: unknown[]) => {
      evalCalls.push(args);
      throw new Error('Redis connection failed');
    });

    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    const response = await rateLimitMiddleware(
      createContext({ model: 'gpt-5.4', max_tokens: 100 }),
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(response?.status).toBe(429);
  });

  test('fail-closed: Redis error on TPM check returns 429', async () => {
    let callCount = 0;
    mockRedisEval.mockReset();
    mockRedisEval.mockImplementation(async (...args: unknown[]) => {
      evalCalls.push(args);
      callCount++;
      if (callCount === 1) return [1, 1];
      throw new Error('Redis connection failed');
    });

    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    const response = await rateLimitMiddleware(
      createContext({ model: 'gpt-5.4', max_tokens: 100 }),
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(response?.status).toBe(429);
  });

  test('burst RPM: multiple same-ms requests all counted via unique member suffix', async () => {
    const rpmState = new Map<string, Set<string>>();
    mockRedisEval.mockReset();
    mockRedisEval.mockImplementation(async (...args: unknown[]) => {
      evalCalls.push(args);
      const script = args[0] as string;
      const key = args[2] as string;
      const limit = args[5] as number;
      const member = (args[9] as string) ?? 'unknown';

      if (script.includes('ratelimit:rpm')) {
        const set = rpmState.get(key) ?? new Set<string>();
        const count = set.size;
        if (count >= limit) {
          return [0, count];
        }
        set.add(member);
        rpmState.set(key, set);
        return [1, count + 1];
      }
      return [1, 1];
    });

    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    const context = createContext({ model: 'gpt-5.4', max_tokens: 10 });

    for (let i = 0; i < 3; i++) {
      await rateLimitMiddleware(context, next);
    }

    expect(next).toHaveBeenCalledTimes(3);
    const rpmCalls = evalCalls.filter((c) => (c[2] as string)?.startsWith('ratelimit:rpm'));
    const suffixes = rpmCalls.map((c) => c[9] as string);
    expect(new Set(suffixes).size).toBe(3);
  });

  test('burst TPM: multiple same-ms requests all count tokens via unique member suffix', async () => {
    const tpmState = new Map<string, Array<{ member: string; tokens: number }>>();
    mockRedisEval.mockReset();
    mockRedisEval.mockImplementation(async (...args: unknown[]) => {
      evalCalls.push(args);
      const script = args[0] as string;
      const key = args[2] as string;
      const tokenCount = args[5] as number;
      const limit = args[6] as number;
      const memberSuffix = args[8] as string;

      if (script.includes('ratelimit:tpm')) {
        const entries = tpmState.get(key) ?? [];
        const total = entries.reduce((sum, e) => sum + e.tokens, 0);
        if (total + tokenCount > limit) {
          return [0, total];
        }
        const member = `${args[3]}:${tokenCount}:${memberSuffix}`;
        entries.push({ member, tokens: tokenCount });
        tpmState.set(key, entries);
        return [1, total + tokenCount];
      }

      return [1, 1];
    });

    const { rateLimitMiddleware } = await import('../../../src/middleware/rate-limit');
    const next = vi.fn(async () => undefined) as Next;

    const context = createContext({ model: 'gpt-5.4', max_tokens: 100 });

    for (let i = 0; i < 3; i++) {
      await rateLimitMiddleware(context, next);
    }

    expect(next).toHaveBeenCalledTimes(3);
    const tpmCalls = evalCalls.filter((c) => (c[2] as string)?.startsWith('ratelimit:tpm'));
    const suffixes = tpmCalls.map((c) => c[8] as string);
    expect(new Set(suffixes).size).toBe(3);
  });
});
