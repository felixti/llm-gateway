import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { budgetScopeTag } from '@shared/budget/keys';
import type { UsageEvent } from '@shared/contracts/usage-event';
import { createMemoryUsageQueue } from '@shared/queue/memory-queue';
import { createApp, type AppDeps } from './app';
import { createBudgetStore } from './kernel/budget-store/store';
import { createMemoryConfigStore } from './kernel/config-store/memory-store';
import { syncBudgetPolicy } from './kernel/policy-sync';
import { createRateStore } from './kernel/rate-store/store';

const ISS = 'https://issuer/v2.0', AUD = 'api://llm-gateway-internal', APP = 'yarp';
let deps: AppDeps;
let privateKey: CryptoKey;
let walDir: string;
const mint = () => new SignJWT({ appid: APP }).setProtectedHeader({ alg: 'RS256', kid: 't' })
  .setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime('5m').sign(privateKey);

beforeAll(async () => {
  const kp = await generateKeyPair('RS256'); privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey); jwk.kid = 't'; jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] }) as JWTVerifyGetKey;
  const redis = new RedisMock({ data: {} }) as unknown as Redis;
  const budgetStore = createBudgetStore(redis);
  const rateStore = createRateStore(redis);
  walDir = mkdtempSync(join(tmpdir(), 'gateway-e2e-wal-'));

  const scope = budgetScopeTag({ principalKind: 'sp', principalId: 'app1', projectId: 'proj1' });
  await syncBudgetPolicy(redis, scope, {
    principalId: 'proj1',
    scopeKind: 'project',
    capUsd: '100.000000',
    period: 'monthly',
    hard: true,
  });
  await redis.set(`${scope}:spent`, '0');
  await redis.set(`${scope}:reserved`, '0');

  deps = {
    auth: { orgId: 'internal', m2m: { jwks, issuer: ISS, audience: AUD, appId: APP } },
    configStore: createMemoryConfigStore(),
    budgetStore,
    rateStore,
    redis,
    usageQueue: createMemoryUsageQueue(),
    walDir,
    rateLimitRpm: 1000,
    rateLimitTpm: 1_000_000,
    reservationTtlSec: 300,
    reserveMultiplier: 1.2,
    commitIdempotencyTtlSec: 604_800,
    upstreamMode: 'stub',
  };
});

afterAll(() => {
  rmSync(walDir, { recursive: true, force: true });
});

const authd = async (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${await mint()}`, 'content-type': 'application/json',
  'x-principal-id': 'app1', 'x-principal-kind': 'sp', 'x-principal-project': 'proj1', ...extra,
});

describe('end-to-end pipeline', () => {
  it('401 unauthenticated chat', async () => {
    const res = await createApp(deps).request('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
  it('200 stub for allowed chat model', async () => {
    const res = await createApp(deps).request('/v1/chat/completions', {
      method: 'POST', headers: await authd(),       body: JSON.stringify({ model: 'gpt-4.1', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stub: true, model: 'gpt-4.1', principal: 'app1' });
  });
  it('bridges chat completions to Responses API for codex models', async () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.cognitiveservices.azure.com';
    process.env.AZURE_OPENAI_KEY = 'test-key';

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload.input).toBe('ping');
      expect(payload.model).toBe('gpt-5.1-codex-mini');
      return new Response(
        JSON.stringify({
          id: 'resp_test',
          model: 'gpt-5.1-codex-mini',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'pong' }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const app = createApp({
        ...deps,
        upstreamMode: 'azure',
      });
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: await authd(),
        body: JSON.stringify({
          model: 'gpt-5.1-codex-mini',
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.object).toBe('chat.completion');
      expect(json.choices?.[0]?.message?.content).toBe('pong');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/openai/responses');
    } finally {
      vi.unstubAllGlobals();
      delete process.env.AZURE_OPENAI_ENDPOINT;
      delete process.env.AZURE_OPENAI_KEY;
    }
  });
  it('200 stub for /v1/responses', async () => {
    const res = await createApp(deps).request('/v1/responses', {
      method: 'POST',
      headers: await authd(),
      body: JSON.stringify({ model: 'gpt-5.1-codex-mini', input: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stub: true, model: 'gpt-5.1-codex-mini' });
  });
  it('200 stub for allowed messages model', async () => {
    const res = await createApp(deps).request('/v1/messages', {
      method: 'POST', headers: await authd(), body: JSON.stringify({ model: 'Kimi-K2.5', messages: [] }),
    });
    expect(res.status).toBe(200);
  });
  it('403 for disallowed model', async () => {
    const res = await createApp(deps).request('/v1/chat/completions', {
      method: 'POST', headers: await authd(), body: JSON.stringify({ model: 'unknown-model' }),
    });
    expect(res.status).toBe(403);
  });
  it('emits a usage event to the queue after a successful chat request', async () => {
    const queue = createMemoryUsageQueue();
    const app = createApp({ ...deps, usageQueue: queue });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: await authd({ 'x-request-id': 'req-usage-emit' }),
      body: JSON.stringify({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(res.status).toBe(200);

    const [message] = await queue.receive(1, 30);
    expect(message).toBeDefined();
    const event = JSON.parse(message!.body) as UsageEvent;
    expect(event.request_id).toBe('req-usage-emit');
    expect(event.redis_commit_result).toBe('ok');
    expect(event.model).toBe('gpt-4.1');
    expect(event.cost_usd).toMatch(/^\d+\.\d{6}$/);
  });
  it('writes WAL when queue enqueue fails', async () => {
    const failingQueue = {
      enqueue: vi.fn().mockRejectedValue(new Error('queue down')),
      receive: vi.fn().mockResolvedValue([]),
      deleteMessage: vi.fn(),
    };
    const app = createApp({ ...deps, usageQueue: failingQueue, walDir });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: await authd({ 'x-request-id': 'req-wal-fallback' }),
      body: JSON.stringify({ model: 'gpt-4.1', messages: [] }),
    });
    expect(res.status).toBe(200);

    const walFiles = readdirSync(walDir).filter((name) => name.includes('req-wal-fallback'));
    expect(walFiles).toHaveLength(1);
  });
});
