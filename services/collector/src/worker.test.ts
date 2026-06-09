import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UsageEvent } from '@shared/contracts/usage-event';
import { createMemoryUsageQueue } from '@shared/queue/memory-queue';

import { pollUsageQueue, startCollectorWorker } from './worker';

function sampleEvent(requestId: string): UsageEvent {
  return {
    request_id: requestId,
    event_id: `evt-${requestId}`,
    attempt: 0,
    ts: '2026-06-09T12:00:00.000Z',
    principal_id: 'app1',
    principal_kind: 'sp',
    project_id: 'proj1',
    model: 'gpt-5.4',
    deployment: 'gpt-5.4-global',
    provider: 'azure-openai',
    tokens_prompt: 10,
    tokens_completion: 5,
    tokens_total: 15,
    cost_usd: '0.000100',
    status: 'completed',
    latency_ms: 50,
    redis_commit_result: 'ok',
    reservation_id: 'res-1',
    scope: '{proj:proj1}',
  };
}

describe('pollUsageQueue', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'collector-out-'));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('writes a batch file and deletes accepted messages', async () => {
    const queue = createMemoryUsageQueue();
    await queue.enqueue(JSON.stringify(sampleEvent('req-1')));
    await queue.enqueue(JSON.stringify(sampleEvent('req-2')));

    const accepted = await pollUsageQueue({ queue, outDir, batchSize: 32 });
    expect(accepted).toBe(2);

    const files = readdirSync(outDir).filter((name) => name.startsWith('batch-'));
    expect(files).toHaveLength(1);

    const batch = JSON.parse(readFileSync(join(outDir, files[0]!), 'utf8')) as UsageEvent[];
    expect(batch.map((event) => event.request_id).sort()).toEqual(['req-1', 'req-2']);

    const remaining = await queue.receive(10, 1);
    expect(remaining).toHaveLength(0);
  });

  it('returns zero when the queue is empty', async () => {
    const queue = createMemoryUsageQueue();
    const accepted = await pollUsageQueue({ queue, outDir });
    expect(accepted).toBe(0);
    expect(readdirSync(outDir)).toHaveLength(0);
  });
});

describe('startCollectorWorker', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'collector-worker-'));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('polls on an interval and updates stats', async () => {
    const queue = createMemoryUsageQueue();
    await queue.enqueue(JSON.stringify(sampleEvent('req-interval')));

    const worker = startCollectorWorker({
      queue,
      outDir,
      intervalMs: 25,
      batchSize: 32,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    const stats = worker.getStats();
    expect(stats.batchesWritten).toBeGreaterThanOrEqual(1);
    expect(stats.lastBatchAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    worker.stop();
  });
});
