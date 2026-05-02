import { archiveMonthlyUsage, getRequestAuditStats } from '@/db/data-access';
import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
import { cleanupOrphanedReservations } from '@/services/quota.service';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;

let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let archiveInterval: ReturnType<typeof setInterval> | null = null;
let cleanupRunning = false;
let archiveRunning = false;

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function runCleanupJob(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;

  try {
    const cleaned = await cleanupOrphanedReservations();
    if (cleaned > 0) {
      logger.info('Cleaned up orphaned reservations', { count: cleaned });
    }
  } catch (error) {
    logger.error('Cleanup job failed', { error });
  } finally {
    cleanupRunning = false;
  }
}

export async function runArchiveJob(): Promise<void> {
  if (archiveRunning) return;
  archiveRunning = true;

  const currentMonth = currentMonthKey();

  try {
    const pattern = 'quota:*';
    let cursor = '0';
    const archivedSet = new Set<string>();

    do {
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
        if (archivedSet.has(dedupeKey)) continue;

        const data = await redis.hgetall(key);
        if (!data?.spent) continue;

        const stats = await getRequestAuditStats(userId, month);

        await archiveMonthlyUsage({
          userId,
          month,
          totalRequests: stats.totalRequests,
          totalTokensInput: stats.totalTokensInput,
          totalTokensOutput: stats.totalTokensOutput,
          totalTokensThinking: stats.totalTokensThinking,
          totalCostUsd: data.spent,
        });

        archivedSet.add(dedupeKey);
      }
    } while (cursor !== '0');

    if (archivedSet.size > 0) {
      logger.info('Archived monthly usage', { count: archivedSet.size });
    }
  } catch (error) {
    logger.error('Archive job failed', { error });
  } finally {
    archiveRunning = false;
  }
}

export function startBackgroundJobs(): void {
  if (cleanupInterval !== null || archiveInterval !== null) {
    return;
  }

  cleanupInterval = setInterval(runCleanupJob, CLEANUP_INTERVAL_MS);
  archiveInterval = setInterval(runArchiveJob, ARCHIVE_INTERVAL_MS);

  if (cleanupInterval.unref) cleanupInterval.unref();
  if (archiveInterval.unref) archiveInterval.unref();

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
  logger.info('Background jobs stopped');
}
