import { env } from '@/config/env';
import {
  batchArchiveMonthlyUsage,
  batchGetRequestAuditStats,
  batchResolveUserIds,
  getMonthlySpentFromAudit,
} from '@/db/data-access';
import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
import { cleanupOrphanedReservations } from '@/services/quota.service';
import { MAX_SCAN_ITERATIONS } from '@/services/quota/constants';
import { Decimal } from 'decimal.js';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;
const LOCK_TTL_SECONDS = 300;

async function acquireLock(lockKey: string): Promise<boolean> {
  try {
    const acquired = await redis.set(lockKey, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    return acquired === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock(lockKey: string): Promise<void> {
  try {
    await redis.del(lockKey);
  } catch {
    void 0;
  }
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let archiveInterval: ReturnType<typeof setInterval> | null = null;
let reconcilerInterval: ReturnType<typeof setInterval> | null = null;
let cleanupRunning = false;
let archiveRunning = false;
let reconcilerRunning = false;

const RECONCILER_DRIFT_TOLERANCE_MICRO = 1;

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function runCleanupJob(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;

  const lockKey = 'scheduler:cleanup:lock';
  if (!(await acquireLock(lockKey))) {
    cleanupRunning = false;
    return;
  }

  try {
    const cleaned = await cleanupOrphanedReservations();
    if (cleaned > 0) {
      logger.info({ count: cleaned }, 'Cleaned up orphaned reservations');
    }
  } catch (error) {
    logger.error({ error }, 'Cleanup job failed');
  } finally {
    await releaseLock(lockKey);
    cleanupRunning = false;
  }
}

export async function runArchiveJob(): Promise<void> {
  if (archiveRunning) return;
  archiveRunning = true;

  const lockKey = 'scheduler:archive:lock';
  if (!(await acquireLock(lockKey))) {
    archiveRunning = false;
    return;
  }

  const currentMonth = currentMonthKey();

  try {
    const pattern = 'quota:*';
    let cursor = '0';
    const dedupeSet = new Set<string>();

    // Phase 1: Collect all unique userId:month pairs from Redis (zero PG round-trips)
    const pendingArchives: Array<{ userId: string; month: string; spent: string }> = [];
    let scanIterations = 0;

    do {
      scanIterations++;
      if (scanIterations > MAX_SCAN_ITERATIONS) {
        logger.warn({ scanIterations }, 'Max SCAN iterations exceeded in runArchiveJob');
        break;
      }

      const scanResult = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = scanResult[0];
      const keys = scanResult[1];

      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length < 3) continue;

        const userId = parts[1];
        const month = parts[2];
        const dedupeKey = `${userId}:${month}`;

        if (month >= currentMonth) continue;
        if (dedupeSet.has(dedupeKey)) continue;
        dedupeSet.add(dedupeKey);

        const data = await redis.hgetall(key);
        if (!data?.spent) continue;

        pendingArchives.push({ userId, month, spent: data.spent });
      }
    } while (cursor !== '0');

    if (pendingArchives.length === 0) return;

    // Phase 2: Batch-resolve all userIds to UUIDs (1 PG round-trip)
    const uniqueUserIds = [...new Set(pendingArchives.map((a) => a.userId))];
    const resolutionMap = await batchResolveUserIds(uniqueUserIds);

    // Phase 3: Batch-fetch audit stats (1 PG round-trip)
    const statsEntries = pendingArchives
      .map((a) => {
        const resolvedId = resolutionMap.get(a.userId);
        return resolvedId ? { resolvedUserId: resolvedId, month: a.month } : null;
      })
      .filter((e): e is { resolvedUserId: string; month: string } => e !== null);

    const statsMap = await batchGetRequestAuditStats(statsEntries);

    // Phase 4: Batch-upsert archive records (1 PG round-trip)
    const archiveRecords = pendingArchives
      .map((a) => {
        const resolvedId = resolutionMap.get(a.userId);
        if (!resolvedId) return null;

        const statsKey = `${resolvedId}:${a.month}`;
        const stats = statsMap.get(statsKey) ?? {
          totalRequests: 0,
          totalTokensInput: 0,
          totalTokensOutput: 0,
          totalTokensThinking: 0,
        };

        return {
          resolvedUserId: resolvedId,
          userId: a.userId,
          month: a.month,
          totalRequests: stats.totalRequests,
          totalTokensInput: stats.totalTokensInput,
          totalTokensOutput: stats.totalTokensOutput,
          totalTokensThinking: stats.totalTokensThinking,
          totalCostUsd: a.spent,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    await batchArchiveMonthlyUsage(archiveRecords);

    if (archiveRecords.length > 0) {
      logger.info({ count: archiveRecords.length }, 'Archived monthly usage');
    }
  } catch (error) {
    logger.error({ error }, 'Archive job failed');
  } finally {
    await releaseLock(lockKey);
    archiveRunning = false;
  }
}

export async function runReconcilerJob(): Promise<void> {
  if (reconcilerRunning) return;
  reconcilerRunning = true;

  const lockKey = 'scheduler:reconciler:lock';
  if (!(await acquireLock(lockKey))) {
    reconcilerRunning = false;
    return;
  }

  try {
    const month = currentMonthKey();
    const pattern = `quota:*:${month}`;
    let cursor = '0';
    let scanIterations = 0;
    const userIds = new Set<string>();

    do {
      scanIterations++;
      if (scanIterations > MAX_SCAN_ITERATIONS) {
        logger.warn({ scanIterations }, 'Max SCAN iterations exceeded in runReconcilerJob');
        break;
      }
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length >= 3) userIds.add(parts[1]);
      }
    } while (cursor !== '0');

    if (userIds.size === 0) return;

    const resolveMap = await batchResolveUserIds([...userIds]);
    let drifted = 0;

    for (const patUserId of userIds) {
      const resolved = resolveMap.get(patUserId);
      if (!resolved) continue;

      const truthUsd = await getMonthlySpentFromAudit(resolved, month);
      const truthMicro = new Decimal(truthUsd).times(1_000_000).toFixed(0);

      const quotaKey = `quota:${patUserId}:${month}`;
      const currentMicro = (await redis.hget(quotaKey, 'spent')) ?? '0';

      const driftAbs = Math.abs(Number(truthMicro) - Number(currentMicro));
      if (driftAbs > RECONCILER_DRIFT_TOLERANCE_MICRO) {
        await redis.hset(quotaKey, 'spent', truthMicro);
        drifted++;
        logger.info(
          {
            userId: patUserId,
            month,
            before: currentMicro,
            after: truthMicro,
            drift: driftAbs,
          },
          'Reconciler corrected quota.spent drift'
        );
      }
    }

    if (drifted > 0) {
      logger.info({ drifted, scanned: userIds.size }, 'Reconciler job complete');
    }
  } catch (error) {
    logger.error({ error }, 'Reconciler job failed');
  } finally {
    await releaseLock(lockKey);
    reconcilerRunning = false;
  }
}

export function startBackgroundJobs(): void {
  if (cleanupInterval !== null || archiveInterval !== null || reconcilerInterval !== null) {
    return;
  }

  cleanupInterval = setInterval(runCleanupJob, CLEANUP_INTERVAL_MS);
  archiveInterval = setInterval(runArchiveJob, ARCHIVE_INTERVAL_MS);
  reconcilerInterval = setInterval(runReconcilerJob, env.RECONCILER_INTERVAL_MS);

  if (cleanupInterval.unref) cleanupInterval.unref();
  if (archiveInterval.unref) archiveInterval.unref();
  if (reconcilerInterval.unref) reconcilerInterval.unref();

  logger.info('Background jobs started');
}

export function stopBackgroundJobs(): void {
  if (cleanupInterval !== null) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (archiveInterval !== null) {
    clearInterval(archiveInterval);
    archiveInterval = null;
  }
  if (reconcilerInterval !== null) {
    clearInterval(reconcilerInterval);
    reconcilerInterval = null;
  }
  logger.info('Background jobs stopped');
}
