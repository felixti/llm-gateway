import { archiveMonthlyUsage } from '@/db/data-access';
import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
import { cleanupOrphanedReservations } from '@/services/quota.service';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;

let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let archiveInterval: ReturnType<typeof setInterval> | null = null;
let cleanupRunning = false;
let archiveRunning = false;

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

async function runArchiveJob(): Promise<void> {
  if (archiveRunning) return;
  archiveRunning = true;

  try {
    const pattern = 'quota:*';
    let cursor = '0';
    const archivedUsers: string[] = [];

    do {
      const scanResult = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = scanResult[0];
      const keys = scanResult[1];

      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length >= 3) {
          const userId = parts[1];
          const month = parts[2];

          if (!archivedUsers.includes(`${userId}:${month}`)) {
            const data = await redis.hgetall(key);
            if (data?.spent) {
              await archiveMonthlyUsage({
                userId,
                month,
                totalRequests: 0,
                totalTokensInput: 0,
                totalTokensOutput: 0,
                totalTokensThinking: 0,
                totalCostUsd: data.spent,
              });
              archivedUsers.push(`${userId}:${month}`);
            }
          }
        }
      }
    } while (cursor !== '0');

    if (archivedUsers.length > 0) {
      logger.info('Archived monthly usage', { count: archivedUsers.length });
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
