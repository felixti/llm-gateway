import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { UsageEvent } from '@shared/contracts/usage-event';
import type { UsageQueue } from '@shared/queue/types';

export interface CollectorWorkerDeps {
  queue: UsageQueue;
  outDir: string;
  batchSize?: number;
}

export interface CollectorWorkerStats {
  queueDepthHint: number;
  batchesWritten: number;
  lastBatchAt: string | null;
}

export interface CollectorWorkerHandle {
  stop(): void;
  getStats(): CollectorWorkerStats;
}

const DEFAULT_BATCH_SIZE = 32;

function parseUsageEvents(messages: { body: string }[]): UsageEvent[] {
  return messages.map((message) => JSON.parse(message.body) as UsageEvent);
}

async function ensureOutDir(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
}

export async function pollUsageQueue(deps: CollectorWorkerDeps): Promise<number> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const messages = await deps.queue.receive(batchSize, 30);
  if (messages.length === 0) {
    return 0;
  }

  const events = parseUsageEvents(messages);
  await ensureOutDir(deps.outDir);

  const batchId = randomUUID();
  const fileName = `batch-${Date.now()}-${batchId}.json`;
  const filePath = join(deps.outDir, fileName);
  await writeFile(filePath, `${JSON.stringify(events, null, 2)}\n`, { mode: 0o600 });

  for (const message of messages) {
    await deps.queue.deleteMessage(message.id, message.popReceipt);
  }

  return events.length;
}

export function startCollectorWorker(deps: {
  queue: UsageQueue;
  outDir: string;
  intervalMs: number;
  batchSize?: number;
}): CollectorWorkerHandle {
  const stats: CollectorWorkerStats = {
    queueDepthHint: 0,
    batchesWritten: 0,
    lastBatchAt: null,
  };

  const poll = async () => {
    const accepted = await pollUsageQueue({
      queue: deps.queue,
      outDir: deps.outDir,
      batchSize: deps.batchSize,
    });
    stats.queueDepthHint = accepted;
    if (accepted > 0) {
      stats.batchesWritten += 1;
      stats.lastBatchAt = new Date().toISOString();
    }
  };

  void poll();
  const timer = setInterval(() => {
    void poll();
  }, deps.intervalMs);
  if (timer.unref) {
    timer.unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
    getStats() {
      return { ...stats };
    },
  };
}
