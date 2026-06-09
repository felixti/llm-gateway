import type { UsageQueue } from '@shared/queue/types';

import {
  listUsageWalEntries,
  removeUsageWalEntry,
  resolveUsageWalDir,
} from './usage-wal';

export interface WalReplayerDeps {
  queue: UsageQueue;
  walDir?: string;
  intervalMs: number;
}

export interface WalReplayerHandle {
  stop(): void;
}

export async function drainUsageWalOnce(deps: WalReplayerDeps): Promise<number> {
  const walDir = resolveUsageWalDir(deps.walDir);
  const entries = await listUsageWalEntries(walDir);
  let replayed = 0;

  for (const event of entries) {
    try {
      await deps.queue.enqueue(JSON.stringify(event));
      await removeUsageWalEntry(event.request_id, walDir);
      replayed += 1;
    } catch {
      // Leave entry on disk for the next tick.
    }
  }

  return replayed;
}

export function startWalReplayer(deps: WalReplayerDeps): WalReplayerHandle {
  const timer = setInterval(() => {
    void drainUsageWalOnce(deps);
  }, deps.intervalMs);

  if (timer.unref) {
    timer.unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
