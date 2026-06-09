import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageEvent } from '@shared/contracts/usage-event';

import {
  listUsageWalEntries,
  removeUsageWalEntry,
  writeUsageWalEntry,
} from './usage-wal';

function sampleEvent(requestId: string): UsageEvent {
  return {
    request_id: requestId,
    event_id: `evt-${requestId}`,
    attempt: 0,
    ts: '2026-06-09T12:00:00.000Z',
    principal_id: 'user-1',
    principal_kind: 'user',
    model: 'gpt-5-mini',
    deployment: 'gpt-5-mini',
    provider: 'azure-openai',
    tokens_prompt: 100,
    tokens_completion: 50,
    tokens_total: 150,
    cost_usd: '0.001500',
    status: 'completed',
    latency_ms: 250,
    redis_commit_result: 'ok',
    reservation_id: 'res-1',
    scope: '{user:user-1}',
  };
}

describe('usage WAL', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-wal-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes atomic unbilled files with secure permissions intent', async () => {
    await writeUsageWalEntry(sampleEvent('req-1'), dir);

    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(files).toEqual(['unbilled-req-1.json']);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);

    const parsed = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as UsageEvent;
    expect(parsed.request_id).toBe('req-1');
    expect(parsed.cost_usd).toBe('0.001500');
  });

  it('rejects unsafe request ids', async () => {
    await expect(
      writeUsageWalEntry({ ...sampleEvent('../etc/passwd'), request_id: '../etc/passwd' }, dir),
    ).rejects.toThrow(/Invalid requestId/);
  });

  it('lists and removes entries', async () => {
    await writeUsageWalEntry(sampleEvent('req-2'), dir);
    await writeUsageWalEntry(sampleEvent('req-3'), dir);

    const entries = await listUsageWalEntries(dir);
    expect(entries.map((entry) => entry.request_id).sort()).toEqual(['req-2', 'req-3']);

    await removeUsageWalEntry('req-2', dir);
    expect(existsSync(join(dir, 'unbilled-req-2.json'))).toBe(false);

    const remaining = await listUsageWalEntries(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.request_id).toBe('req-3');
  });
});
