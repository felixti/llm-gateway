import { getUserQuotaPolicyByPatSubject } from '@/db/data-access';
import { redis } from '@/db/redis';
import { logger } from '@/observability/logger';
import { incrementQuotaHydrationFailures } from '@/observability/metrics';
import { Decimal } from 'decimal.js';
import { DB_POLICY_SYNC_INTERVAL_MS, DEFAULT_BUDGET_USD } from './constants';
import { getQuotaKey } from './keys';
import { toMicrodollars } from './money';

function shouldSyncQuotaFromPostgres(): boolean {
  if (process.env.NODE_ENV === 'test' && process.env.QUOTA_PG_SYNC_IN_TESTS !== 'true') {
    return false;
  }
  return true;
}

export async function syncQuotaPolicyFromPostgres(userId: string, month: string): Promise<void> {
  if (!shouldSyncQuotaFromPostgres()) {
    return;
  }

  const quotaKey = getQuotaKey(userId, month);

  try {
    const syncedAt = await redis.hget(quotaKey, 'db_synced_at');
    if (syncedAt && Date.now() - Number(syncedAt) < DB_POLICY_SYNC_INTERVAL_MS) {
      return;
    }

    const policy = await getUserQuotaPolicyByPatSubject(userId);
    const budgetDollars = new Decimal(policy?.monthly_budget_usd ?? DEFAULT_BUDGET_USD);
    const budgetMicro = toMicrodollars(budgetDollars);
    const hardLimit = policy?.hard_limit !== false;

    await redis.hset(quotaKey, {
      budget: budgetMicro,
      hard_limit: hardLimit ? '1' : '0',
      db_synced_at: String(Date.now()),
    });
  } catch (error) {
    incrementQuotaHydrationFailures();
    logger.warn({ userId, error }, 'Quota policy sync from Postgres failed; using Redis defaults');
  }
}
