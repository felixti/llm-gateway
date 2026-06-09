import type Redis from 'ioredis';
import { budgetKeys } from '@shared/budget/keys';
import { COMMIT_SCRIPT, RELEASE_SCRIPT, RESERVE_SCRIPT } from './scripts';

export interface BudgetStore {
  reserve(
    scope: string,
    reservationId: string,
    costMicro: bigint,
    ttlSec: number,
  ): Promise<'ok' | 'insufficient'>;
  commit(
    scope: string,
    reservationId: string,
    requestId: string,
    actualMicro: bigint,
    idempotencyTtlSec: number,
  ): Promise<'ok' | 'already'>;
  release(scope: string, reservationId: string): Promise<void>;
}

declare module 'ioredis' {
  interface RedisCommander {
    budgetReserve(...args: (string | number)[]): Promise<[number, string]>;
    budgetCommit(...args: (string | number)[]): Promise<[number, string]>;
    budgetRelease(...args: (string | number)[]): Promise<[number, string]>;
  }
}

export function registerBudgetScripts(redis: Redis): void {
  redis.defineCommand('budgetReserve', { numberOfKeys: 4, lua: RESERVE_SCRIPT });
  redis.defineCommand('budgetCommit', { numberOfKeys: 4, lua: COMMIT_SCRIPT });
  redis.defineCommand('budgetRelease', { numberOfKeys: 2, lua: RELEASE_SCRIPT });
}

export function createBudgetStore(redis: Redis): BudgetStore {
  registerBudgetScripts(redis);

  return {
    async reserve(scope, reservationId, costMicro, ttlSec) {
      const keys = budgetKeys(scope);
      const [okFlag, status] = await redis.budgetReserve(
        keys.spent,
        keys.reserved,
        keys.policy,
        keys.reservation(reservationId),
        costMicro.toString(),
        ttlSec,
      );
      if (okFlag === 0 && status === 'insufficient') return 'insufficient';
      if (okFlag === 1 && status === 'ok') return 'ok';
      throw new Error(`unexpected reserve result: ${okFlag}:${status}`);
    },

    async commit(scope, reservationId, requestId, actualMicro, idempotencyTtlSec) {
      const keys = budgetKeys(scope);
      const [okFlag, status] = await redis.budgetCommit(
        keys.spent,
        keys.reserved,
        keys.reservation(reservationId),
        keys.commitIdempotency(requestId),
        actualMicro.toString(),
        idempotencyTtlSec,
      );
      if (okFlag === 0 && status === 'already') return 'already';
      if (okFlag === 1 && status === 'ok') return 'ok';
      throw new Error(`unexpected commit result: ${okFlag}:${status}`);
    },

    async release(scope, reservationId) {
      const keys = budgetKeys(scope);
      await redis.budgetRelease(keys.reserved, keys.reservation(reservationId));
    },
  };
}
