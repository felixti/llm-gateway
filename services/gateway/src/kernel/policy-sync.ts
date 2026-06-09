import type Redis from 'ioredis';
import type { BudgetPolicy } from '@shared/contracts/tenant';
import { budgetKeys } from '@shared/budget/keys';
import { toMicrodollars } from '@shared/budget/money';

export async function syncBudgetPolicy(
  redis: Redis,
  scope: string,
  policy: BudgetPolicy,
): Promise<void> {
  const keys = budgetKeys(scope);
  await redis.hset(keys.policy, {
    cap_micro: toMicrodollars(policy.capUsd).toString(),
    hard: policy.hard ? '1' : '0',
    period: policy.period,
    'policy:version': '1',
  });
}
