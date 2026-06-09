import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { redis } from '../../../src/db/redis';
import { MockRedis } from '../../integration/helpers/mock-redis';

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as Record<string, unknown>;
  r.scan = mock.scan.bind(mock);
  r.hgetall = mock.hgetall.bind(mock);
  r.hget = mock.hget.bind(mock);
  r.hset = mock.hset.bind(mock);
  r.get = mock.get.bind(mock);
  r.set = mock.set.bind(mock);
  r.eval = mock.eval.bind(mock);
  r.incrbyfloat = mock.incrbyfloat.bind(mock);
  r.del = mock.del.bind(mock);
  r.pipeline = mock.pipeline.bind(mock);
}

describe('scheduler.service - extended coverage', () => {
  let originalSyncFlag: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalSyncFlag = process.env.QUOTA_PG_SYNC_IN_TESTS;
    process.env.QUOTA_PG_SYNC_IN_TESTS = 'true';
  });

  afterEach(() => {
    if (originalSyncFlag === undefined) {
      delete process.env.QUOTA_PG_SYNC_IN_TESTS;
    } else {
      process.env.QUOTA_PG_SYNC_IN_TESTS = originalSyncFlag;
    }
  });

  describe('startBackgroundJobs / stopBackgroundJobs', () => {
    test('startBackgroundJobs does nothing when already running', async () => {
      const { startBackgroundJobs, stopBackgroundJobs } = await import(
        '../../../src/services/scheduler.service'
      );

      startBackgroundJobs();
      startBackgroundJobs();
      stopBackgroundJobs();
    });

    test('stopBackgroundJobs is safe when nothing started', async () => {
      const { stopBackgroundJobs } = await import(
        '../../../src/services/scheduler.service'
      );

      stopBackgroundJobs();
    });
  });

  describe('runArchiveJob - no keys to archive', () => {
    test('completes without archiving when no past-month keys exist', async () => {
      const mock = new MockRedis();
      bindMockRedis(mock);

      const { runArchiveJob } = await import(
        '../../../src/services/scheduler.service'
      );
      await runArchiveJob();
    });
  });
});
