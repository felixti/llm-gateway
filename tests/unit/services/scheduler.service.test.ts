import { describe, expect, test, vi, beforeEach, afterEach } from 'bun:test';
import { redis } from '../../../src/db/redis';
import { MockRedis } from '../../integration/helpers/mock-redis';
import * as dataAccess from '../../../src/db/data-access';

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as Record<string, unknown>;
  r.scan = mock.scan.bind(mock);
  r.hgetall = mock.hgetall.bind(mock);
}

// ── Helpers ──────────────────────────────────────────────────────────

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function pastMonth(): string {
  const now = new Date();
  now.setMonth(now.getMonth() - 1);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function futureMonth(): string {
  const now = new Date();
  now.setMonth(now.getMonth() + 1);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ── Suite ────────────────────────────────────────────────────────────

describe('runArchiveJob', () => {
  let mockRedis: MockRedis;
  let archiveSpy: ReturnType<typeof vi.spyOn>;
  let statsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockRedis = new MockRedis();
    bindMockRedis(mockRedis);
    vi.restoreAllMocks();

    archiveSpy = vi.spyOn(dataAccess, 'archiveMonthlyUsage').mockResolvedValue(undefined);
    statsSpy = vi.spyOn(dataAccess, 'getRequestAuditStats').mockResolvedValue({
      totalRequests: 0,
      totalTokensInput: 0,
      totalTokensOutput: 0,
      totalTokensThinking: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('skips current-month quota keys', async () => {
    // Arrange: one key for current month with spent
    await mockRedis.hset(`quota:user-1:${currentMonth()}`, { spent: '50000' });

    const { runArchiveJob } = await import('../../../src/services/scheduler.service');
    await runArchiveJob();

    expect(archiveSpy).not.toHaveBeenCalled();
  });

  test('skips future-month quota keys', async () => {
    await mockRedis.hset(`quota:user-1:${futureMonth()}`, { spent: '50000' });

    const { runArchiveJob } = await import('../../../src/services/scheduler.service');
    await runArchiveJob();

    expect(archiveSpy).not.toHaveBeenCalled();
  });

  test('processes past-month keys and queries request_audit for real counts', async () => {
    const pm = pastMonth();
    await mockRedis.hset(`quota:user-42:${pm}`, { spent: '123456' });

    statsSpy.mockResolvedValue({
      totalRequests: 15,
      totalTokensInput: 30000,
      totalTokensOutput: 10000,
      totalTokensThinking: 500,
    });

    const { runArchiveJob } = await import('../../../src/services/scheduler.service');
    await runArchiveJob();

    expect(statsSpy).toHaveBeenCalledWith('user-42', pm);
    expect(archiveSpy).toHaveBeenCalledWith({
      userId: 'user-42',
      month: pm,
      totalRequests: 15,
      totalTokensInput: 30000,
      totalTokensOutput: 10000,
      totalTokensThinking: 500,
      totalCostUsd: '123456',
    });
  });

  test('defaults to zero counts when request_audit returns nulls', async () => {
    const pm = pastMonth();
    await mockRedis.hset(`quota:user-99:${pm}`, { spent: '5000' });

    statsSpy.mockResolvedValue({
      totalRequests: 0,
      totalTokensInput: 0,
      totalTokensOutput: 0,
      totalTokensThinking: 0,
    });

    const { runArchiveJob } = await import('../../../src/services/scheduler.service');
    await runArchiveJob();

    expect(archiveSpy).toHaveBeenCalledWith({
      userId: 'user-99',
      month: pm,
      totalRequests: 0,
      totalTokensInput: 0,
      totalTokensOutput: 0,
      totalTokensThinking: 0,
      totalCostUsd: '5000',
    });
  });

  test('skips keys with no spent field', async () => {
    const pm = pastMonth();
    await mockRedis.hset(`quota:user-empty:${pm}`, { budget: '50000000' });

    const { runArchiveJob } = await import('../../../src/services/scheduler.service');
    await runArchiveJob();

    expect(archiveSpy).not.toHaveBeenCalled();
  });

  test('deduplicates user:month pairs across scan batches', async () => {
    const pm = pastMonth();
    // Same key appears twice (SCAN can return duplicates)
    await mockRedis.hset(`quota:user-dup:${pm}`, { spent: '1000' });

    const { runArchiveJob } = await import('../../../src/services/scheduler.service');
    await runArchiveJob();

    // archiveMonthlyUsage should be called exactly once for this user:month
    expect(archiveSpy).toHaveBeenCalledTimes(1);
  });

  test('handles multiple users across different past months', async () => {
    const pm1 = pastMonth();
    const now = new Date();
    now.setMonth(now.getMonth() - 3);
    const pm2 = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    await mockRedis.hset(`quota:user-a:${pm1}`, { spent: '10000' });
    await mockRedis.hset(`quota:user-b:${pm2}`, { spent: '20000' });

    const { runArchiveJob } = await import('../../../src/services/scheduler.service');
    await runArchiveJob();

    expect(archiveSpy).toHaveBeenCalledTimes(2);
  });

  test('does not call getRequestAuditStats for skipped keys', async () => {
    await mockRedis.hset(`quota:user-current:${currentMonth()}`, { spent: '99999' });

    const { runArchiveJob } = await import('../../../src/services/scheduler.service');
    await runArchiveJob();

    expect(statsSpy).not.toHaveBeenCalled();
  });
});
