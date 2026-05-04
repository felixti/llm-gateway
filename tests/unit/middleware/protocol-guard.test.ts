/**
 * Protocol guard — Anthropic count_tokens path must accept Claude deployments only.
 */

import { protocolGuardMiddleware } from '@/middleware/protocol-guard';
import { describe, expect, test, vi } from 'bun:test';
import type { Context, Next } from 'hono';

function createProtocolContext(path: string, body: unknown): Context {
  const vars = new Map<string, unknown>();
  return {
    req: {
      path,
      json: async () => body,
    },
    get: (key: string) => vars.get(key),
    set: (key: string, value: unknown) => {
      vars.set(key, value);
    },
    json: (b: unknown, status: number) => new Response(JSON.stringify(b), { status }),
  } as unknown as Context;
}

function createScopedProtocolContext(path: string, body: unknown, scope: string): Context {
  const ctx = createProtocolContext(path, body);
  ctx.set('scope', scope);
  return ctx;
}

describe('protocolGuardMiddleware — /v1/messages/count_tokens', () => {
  test('allows Claude deployment alias on count_tokens', async () => {
    const next = vi.fn() as Next;

    const ctx = createProtocolContext('/v1/messages/count_tokens', {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = await protocolGuardMiddleware(ctx, next);

    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalled();
    expect(ctx.get('model')).toBe('claude-opus-4-6');
    expect(ctx.get('modelFamily')).toBe('claude');
  });

  test('rejects GPT model on count_tokens', async () => {
    const next = vi.fn() as Next;

    const ctx = createProtocolContext('/v1/messages/count_tokens', {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = await protocolGuardMiddleware(ctx, next);

    expect(result).toBeInstanceOf(Response);
    expect(next).not.toHaveBeenCalled();
    expect((result as Response).status).toBe(400);
  });

  test('allows Claude model when sub-app path is /count_tokens', async () => {
    const next = vi.fn() as Next;

    const ctx = createProtocolContext('/count_tokens', {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = await protocolGuardMiddleware(ctx, next);

    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalled();
    expect(ctx.get('model')).toBe('claude-opus-4-6');
  });
});

describe('protocolGuardMiddleware — model scopes', () => {
  test('allows a model-scoped PAT to call its model', async () => {
    const next = vi.fn() as Next;
    const ctx = createScopedProtocolContext(
      '/v1/chat/completions',
      { model: 'gpt-5.4', messages: [{ role: 'user', content: 'Hello' }] },
      'models:gpt-5.4'
    );

    const result = await protocolGuardMiddleware(ctx, next);

    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  test('rejects a model-scoped PAT calling a different model', async () => {
    const next = vi.fn() as Next;
    const ctx = createScopedProtocolContext(
      '/v1/chat/completions',
      { model: 'gpt-5.4', messages: [{ role: 'user', content: 'Hello' }] },
      'models:gpt-5.3-codex'
    );

    const result = await protocolGuardMiddleware(ctx, next);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
