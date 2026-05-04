import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readWalEntries, removeWalEntry, writeWalEntry } from '../../../src/services/wal.service';

describe('WAL service', () => {
  let dir: string;
  let originalWalDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wal-test-'));
    originalWalDir = process.env.WAL_DIR;
    process.env.WAL_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalWalDir === undefined) {
      delete process.env.WAL_DIR;
    } else {
      process.env.WAL_DIR = originalWalDir;
    }
  });

  test('writeWalEntry creates file with expected content', async () => {
    await writeWalEntry({
      requestId: 'req-1',
      userId: 'user-1',
      model: 'gpt-4o',
      tokensInput: 100,
      tokensOutput: 50,
      tokensThinking: 0,
      costUsd: '0.001500',
      timestamp: new Date('2026-05-04T12:00:00Z').toISOString(),
      reason: 'both_fail',
    });

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('unbilled-req-1.json');

    const content = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    expect(content.requestId).toBe('req-1');
    expect(content.costUsd).toBe('0.001500');
    expect(content.reason).toBe('both_fail');
    expect(content.tokensInput).toBe(100);
    expect(content.tokensOutput).toBe(50);
  });

  test('writeWalEntry uses tmp+rename for atomicity (no .tmp leftovers)', async () => {
    await writeWalEntry({
      requestId: 'req-2',
      userId: 'user-2',
      model: 'gpt-4o',
      tokensInput: 1,
      tokensOutput: 1,
      tokensThinking: 0,
      costUsd: '0.000001',
      timestamp: new Date().toISOString(),
      reason: 'pg_fail',
    });
    const tmpFiles = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  test('writeWalEntry rejects requestId with path-traversal characters', async () => {
    await expect(
      writeWalEntry({
        requestId: '../etc/passwd',
        userId: 'u',
        model: 'gpt-4o',
        tokensInput: 1,
        tokensOutput: 1,
        tokensThinking: 0,
        costUsd: '0.000001',
        timestamp: new Date().toISOString(),
        reason: 'pg_fail',
      })
    ).rejects.toThrow(/Invalid requestId/);
  });

  test('readWalEntries returns all unbilled-*.json files parsed', async () => {
    await writeWalEntry({
      requestId: 'req-3',
      userId: 'u',
      model: 'gpt-4o',
      tokensInput: 1,
      tokensOutput: 1,
      tokensThinking: 0,
      costUsd: '0.000001',
      timestamp: new Date().toISOString(),
      reason: 'redis_fail',
    });
    await writeWalEntry({
      requestId: 'req-4',
      userId: 'u',
      model: 'gpt-4o',
      tokensInput: 2,
      tokensOutput: 2,
      tokensThinking: 0,
      costUsd: '0.000002',
      timestamp: new Date().toISOString(),
      reason: 'redis_fail',
    });
    const entries = await readWalEntries();
    expect(entries).toHaveLength(2);
    const ids = entries.map((e) => e.requestId).sort();
    expect(ids).toEqual(['req-3', 'req-4']);
  });

  test('readWalEntries returns empty array when WAL dir is empty', async () => {
    const entries = await readWalEntries();
    expect(entries).toHaveLength(0);
  });

  test('removeWalEntry deletes the file; second call is no-op', async () => {
    await writeWalEntry({
      requestId: 'req-5',
      userId: 'u',
      model: 'gpt-4o',
      tokensInput: 1,
      tokensOutput: 1,
      tokensThinking: 0,
      costUsd: '0.000001',
      timestamp: new Date().toISOString(),
      reason: 'pg_fail',
    });
    expect(existsSync(join(dir, 'unbilled-req-5.json'))).toBe(true);
    await removeWalEntry('req-5');
    expect(existsSync(join(dir, 'unbilled-req-5.json'))).toBe(false);
    await removeWalEntry('req-5');
  });
});
