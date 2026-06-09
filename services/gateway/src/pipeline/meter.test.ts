import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsageEvent } from '@shared/contracts/usage-event';
import { createMemoryUsageQueue } from '@shared/queue/memory-queue';

import { buildUsageEvent, emitUsageEvent } from './meter';

const baseParams = {
  requestId: 'req-meter-1',
  userAuth: {
    principalId: 'app1',
    principalKind: 'sp' as const,
    projectId: 'proj1',
    orgId: 'internal',
    scopes: ['llm.invoke'],
  },
  tenantContext: {
    principalId: 'app1',
    principalKind: 'sp' as const,
    projectId: 'proj1',
    orgId: 'internal',
    modelAllowlist: ['gpt-5.4'],
    budgetPolicy: null,
  },
  modelConfig: {
    alias: 'gpt-5.4',
    provider: 'azure-openai' as const,
    family: 'openai-chat' as const,
    deploymentName: 'gpt-5.4-global',
    enabled: true,
    priceInPerMillion: '5.000000',
    priceOutPerMillion: '15.000000',
  },
  tokensPrompt: 100,
  tokensCompletion: 50,
  costUsd: '0.001250',
  status: 'completed' as const,
  latencyMs: 42,
  redisCommitResult: 'ok' as const,
  reservationId: 'res-abc',
  scope: '{proj:proj1}',
};

describe('buildUsageEvent', () => {
  it('maps request fields into a UsageEvent', () => {
    const event = buildUsageEvent(baseParams);

    expect(event.request_id).toBe('req-meter-1');
    expect(event.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(event.attempt).toBe(0);
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event.principal_id).toBe('app1');
    expect(event.principal_kind).toBe('sp');
    expect(event.project_id).toBe('proj1');
    expect(event.model).toBe('gpt-5.4');
    expect(event.deployment).toBe('gpt-5.4-global');
    expect(event.provider).toBe('azure-openai');
    expect(event.tokens_prompt).toBe(100);
    expect(event.tokens_completion).toBe(50);
    expect(event.tokens_total).toBe(150);
    expect(event.cost_usd).toBe('0.001250');
    expect(event.status).toBe('completed');
    expect(event.latency_ms).toBe(42);
    expect(event.redis_commit_result).toBe('ok');
    expect(event.reservation_id).toBe('res-abc');
    expect(event.scope).toBe('{proj:proj1}');
  });

  it('omits project_id for user principals', () => {
    const event = buildUsageEvent({
      ...baseParams,
      userAuth: { ...baseParams.userAuth, principalKind: 'user', projectId: null },
      tenantContext: { ...baseParams.tenantContext, principalKind: 'user', projectId: null },
    });

    expect(event.project_id).toBeUndefined();
  });
});

describe('emitUsageEvent', () => {
  let walDir: string;

  beforeEach(() => {
    walDir = mkdtempSync(join(tmpdir(), 'meter-wal-'));
  });

  afterEach(() => {
    rmSync(walDir, { recursive: true, force: true });
  });

  it('enqueues JSON events on success', async () => {
    const queue = createMemoryUsageQueue();
    const event = buildUsageEvent(baseParams);

    const result = await emitUsageEvent({ usageQueue: queue, walDir }, event);
    expect(result).toBe('queued');

    const [message] = await queue.receive(1, 30);
    const parsed = JSON.parse(message!.body) as UsageEvent;
    expect(parsed.request_id).toBe('req-meter-1');
    expect(parsed.cost_usd).toBe('0.001250');
  });

  it('writes WAL entry when enqueue fails', async () => {
    const queue = {
      enqueue: vi.fn().mockRejectedValue(new Error('queue unavailable')),
      receive: vi.fn(),
      deleteMessage: vi.fn(),
    };
    const event = buildUsageEvent({ ...baseParams, requestId: 'req-wal-fallback' });

    const result = await emitUsageEvent({ usageQueue: queue, walDir }, event);
    expect(result).toBe('wal');

    const files = readdirSync(walDir).filter((name) => name.startsWith('unbilled-'));
    expect(files).toHaveLength(1);
    const parsed = JSON.parse(readFileSync(join(walDir, files[0]!), 'utf8')) as UsageEvent;
    expect(parsed.request_id).toBe('req-wal-fallback');
  });
});
