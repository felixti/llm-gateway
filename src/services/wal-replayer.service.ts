/**
 * WAL Replayer Service
 * Drains the dual-failure DLQ (`wal.service.ts`) by retrying Postgres audit
 * inserts. Successful entries are unlinked; transient failures stay on disk
 * for the next tick.
 */

import { env } from '@/config/env';
import { insertRequestAuditOrThrow } from '@/db/data-access';
import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
import { type WalEntry, readWalEntries, removeWalEntry } from './wal.service';

const LOCK_KEY = 'scheduler:wal-replayer:lock';
const LOCK_TTL_SECONDS = 300;
const MAX_BATCH_PER_TICK = 100;

let replayerInterval: ReturnType<typeof setInterval> | null = null;
let replayerRunning = false;

async function acquireLock(): Promise<boolean> {
  try {
    const acquired = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    return acquired === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await redis.del(LOCK_KEY);
  } catch {
    void 0;
  }
}

function entryToAuditPayload(entry: WalEntry): Parameters<typeof insertRequestAuditOrThrow>[0] {
  return {
    userId: entry.userId,
    requestId: entry.requestId,
    model: entry.model,
    deployment: entry.deployment ?? entry.model,
    protocolFamily: entry.protocolFamily ?? 'unknown',
    tokensInput: entry.tokensInput,
    tokensOutput: entry.tokensOutput,
    tokensThinking: entry.tokensThinking,
    costUsd: entry.costUsd,
    thinkingEnabled: entry.thinkingEnabled ?? false,
    azureAuthType: entry.azureAuthType ?? 'unknown',
    durationMs: entry.durationMs ?? 0,
    statusCode: entry.statusCode ?? 200,
  };
}

export async function runWalReplayJob(): Promise<{ replayed: number; failed: number }> {
  if (replayerRunning) return { replayed: 0, failed: 0 };
  replayerRunning = true;

  if (!(await acquireLock())) {
    replayerRunning = false;
    return { replayed: 0, failed: 0 };
  }

  let replayed = 0;
  let failed = 0;

  try {
    const entries = await readWalEntries();
    const batch = entries.slice(0, MAX_BATCH_PER_TICK);

    for (const entry of batch) {
      try {
        const result = await insertRequestAuditOrThrow(entryToAuditPayload(entry));
        if (result === 'inserted' || result === 'skipped_unresolvable_user') {
          await removeWalEntry(entry.requestId);
          replayed++;
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
        logger.warn({ err, requestId: entry.requestId }, 'WAL replay attempt failed; will retry');
      }
    }

    if (replayed > 0 || failed > 0) {
      logger.info(
        { replayed, failed, pending: Math.max(0, entries.length - batch.length) },
        'WAL replayer pass complete'
      );
    }
  } catch (err) {
    logger.error({ err }, 'WAL replayer job failed');
  } finally {
    await releaseLock();
    replayerRunning = false;
  }

  return { replayed, failed };
}

export function startWalReplayer(): void {
  if (replayerInterval !== null) return;
  replayerInterval = setInterval(runWalReplayJob, env.WAL_REPLAY_INTERVAL_MS);
  if (replayerInterval.unref) replayerInterval.unref();
  logger.info({ intervalMs: env.WAL_REPLAY_INTERVAL_MS }, 'WAL replayer started');
}

export function stopWalReplayer(): void {
  if (replayerInterval !== null) {
    clearInterval(replayerInterval);
    replayerInterval = null;
  }
}
