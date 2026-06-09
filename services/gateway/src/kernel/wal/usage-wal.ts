import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { UsageEvent } from '@shared/contracts/usage-event';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;
const DEFAULT_WAL_DIR = '/tmp/ai-gateway-wal';

export function resolveUsageWalDir(walDir?: string): string {
  return walDir ?? process.env.WAL_DIR ?? DEFAULT_WAL_DIR;
}

function entryPath(dir: string, requestId: string): string {
  if (!SAFE_REQUEST_ID.test(requestId)) {
    throw new Error(`Invalid requestId for WAL: ${requestId}`);
  }
  return join(dir, `unbilled-${requestId}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function writeUsageWalEntry(
  event: UsageEvent,
  walDir?: string,
): Promise<void> {
  const dir = resolveUsageWalDir(walDir);
  const finalPath = entryPath(dir, event.request_id);
  await ensureDir(dir);
  const tmpPath = `${finalPath}.tmp`;
  const body = `${JSON.stringify(event)}\n`;
  await writeFile(tmpPath, body, { mode: 0o600 });
  await rename(tmpPath, finalPath);
}

export async function listUsageWalEntries(walDir?: string): Promise<UsageEvent[]> {
  const dir = resolveUsageWalDir(walDir);
  await ensureDir(dir);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const entries: UsageEvent[] = [];
  for (const name of names) {
    if (!name.startsWith('unbilled-') || !name.endsWith('.json')) continue;
    try {
      const text = await readFile(join(dir, name), 'utf8');
      entries.push(JSON.parse(text) as UsageEvent);
    } catch {
      // Skip corrupt entries; replayer will retry on next pass.
    }
  }
  return entries;
}

export async function removeUsageWalEntry(
  requestId: string,
  walDir?: string,
): Promise<void> {
  const dir = resolveUsageWalDir(walDir);
  try {
    await unlink(entryPath(dir, requestId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}
