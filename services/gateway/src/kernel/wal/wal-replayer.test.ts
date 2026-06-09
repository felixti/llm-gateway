import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageEvent } from '@shared/contracts/usage-event';
import { createMemoryUsageQueue } from '@shared/queue/memory-queue';

import { drainUsageWalOnce, startWalReplayer } from './wal-replayer';
import { writeUsageWalEntry } from './usage-wal';

function sampleEvent(requestId: string): UsageEvent {
  return {
    request_id: requestId,
    event_id: `evt-${requestId}`,
    attempt: 0,
    ts: '2026-06-09T12:00:00.000Z',
    principal_id: 'user-1',
    principal_kind: 'user',
    model: 'gpt-5-mini',
    deployment: 'gpt-5-mini',
    provider: 'azure-openai',
    tokens_prompt: 10,
    tokens_completion: 5,
    tokens_total: 15,
    cost_usd: '0.000100',
    status: 'completed',
    latency_ms: 100,
    redis_commit_result: 'ok',
    reservation_id: 'res-1',
    scope: '{user:user-1}',
  };
}

describe('usage WAL replayer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-wal-replay-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drains WAL entries into the queue and removes them on success', async () => {
    const queue = createMemoryUsageQueue();
    await writeUsageWalEntry(sampleEvent('req-1'), dir);
    await writeUsageWalEntry(sampleEvent('req-2'), dir);

    const replayed = await drainUsageWalOnce({ queue, walDir: dir, intervalMs: 100 });
    expect(replayed).toBe(2);

    const messages = await queue.receive(10, 30);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => JSON.parse(message.body).request_id).sort()).toEqual([
      'req-1',
      'req-2',
    ]);
  });

  it('retains WAL entries when enqueue fails', async () => {
    const queue = createMemoryUsageQueue();
    await writeUsageWalEntry(sampleEvent('req-fail'), dir);

    const failingQueue = {
      enqueue: vi.fn().mockRejectedValue(new Error('queue down')),
      receive: queue.receive.bind(queue),
      deleteMessage: queue.deleteMessage.bind(queue),
    };

    const replayed = await drainUsageWalOnce({
      queue: failingQueue,
      walDir: dir,
      intervalMs: 100,
    });
    expect(replayed).toBe(0);

    const entries = await import('./usage-wal').then((mod) => mod.listUsageWalEntries(dir));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.request_id).toBe('req-fail');
  });

  it('runs on an interval until stopped', async () => {
    const queue = createMemoryUsageQueue();
    await writeUsageWalEntry(sampleEvent('req-interval'), dir);

    const handle = startWalReplayer({ queue, walDir: dir, intervalMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const messages = await queue.receive(1, 30);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!.body).request_id).toBe('req-interval');

    handle.stop();
  });
});
