import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type AuditOutcome = 'inserted' | 'skipped_unresolvable_user';
const auditMock = mock<() => Promise<AuditOutcome>>(() => Promise.resolve('inserted'));

mock.module('@/db/data-access', () => ({
  insertRequestAuditOrThrow: (...args: unknown[]) => auditMock(...(args as [])),
}));

mock.module('@/db/redis', () => ({
  redis: {
    set: async () => 'OK',
    del: async () => 1,
  },
}));

import { writeWalEntry } from '../../../src/services/wal.service';
import { runWalReplayJob } from '../../../src/services/wal-replayer.service';

describe('WAL replayer', () => {
  let dir: string;
  let originalWalDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wal-replayer-'));
    originalWalDir = process.env.WAL_DIR;
    process.env.WAL_DIR = dir;
    auditMock.mockReset();
    auditMock.mockImplementation(() => Promise.resolve('inserted'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalWalDir === undefined) {
      delete process.env.WAL_DIR;
    } else {
      process.env.WAL_DIR = originalWalDir;
    }
  });

  test('replays entries successfully and removes files', async () => {
    await writeWalEntry({
      requestId: 'req-replay-1',
      userId: 'user-1',
      model: 'gpt-5.4',
      deployment: 'gpt-5.4-global',
      protocolFamily: 'chat-completions',
      azureAuthType: 'api-key',
      thinkingEnabled: false,
      durationMs: 123,
      statusCode: 200,
      tokensInput: 10,
      tokensOutput: 20,
      tokensThinking: 0,
      costUsd: '0.000123',
      timestamp: new Date().toISOString(),
      reason: 'pg_fail',
    });

    const result = await runWalReplayJob();

    expect(result.replayed).toBe(1);
    expect(result.failed).toBe(0);
    expect(auditMock).toHaveBeenCalledTimes(1);
    const filesAfter = readdirSync(dir).filter((f) => f.startsWith('unbilled-'));
    expect(filesAfter).toHaveLength(0);
  });

  test('keeps entry on Postgres failure and reports failed count', async () => {
    auditMock.mockImplementation(() => Promise.reject(new Error('pg down')));

    await writeWalEntry({
      requestId: 'req-replay-2',
      userId: 'user-2',
      model: 'gpt-5.4',
      tokensInput: 5,
      tokensOutput: 5,
      tokensThinking: 0,
      costUsd: '0.000050',
      timestamp: new Date().toISOString(),
      reason: 'both_fail',
    });

    const result = await runWalReplayJob();

    expect(result.replayed).toBe(0);
    expect(result.failed).toBe(1);
    expect(existsSync(join(dir, 'unbilled-req-replay-2.json'))).toBe(true);
  });

  test('drops entries with unresolvable user (deterministic skip)', async () => {
    auditMock.mockImplementation(() => Promise.resolve('skipped_unresolvable_user'));

    await writeWalEntry({
      requestId: 'req-replay-3',
      userId: 'unresolvable',
      model: 'gpt-5.4',
      tokensInput: 1,
      tokensOutput: 1,
      tokensThinking: 0,
      costUsd: '0.000001',
      timestamp: new Date().toISOString(),
      reason: 'pg_fail',
    });

    const result = await runWalReplayJob();

    expect(result.replayed).toBe(1);
    expect(existsSync(join(dir, 'unbilled-req-replay-3.json'))).toBe(false);
  });
});
