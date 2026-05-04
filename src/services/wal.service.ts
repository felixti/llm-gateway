import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { env } from '@/config/env';
import { logger } from '@/observability/logger';

export interface WalEntry {
  requestId: string;
  userId: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  tokensThinking: number;
  costUsd: string;
  timestamp: string;
  reason: 'redis_fail' | 'pg_fail' | 'both_fail';
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;

function walDir(): string {
  return process.env.WAL_DIR ?? env.WAL_DIR;
}

function entryPath(requestId: string): string {
  if (!SAFE_REQUEST_ID.test(requestId)) {
    throw new Error(`Invalid requestId for WAL: ${requestId}`);
  }
  return join(walDir(), `unbilled-${requestId}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(walDir(), { recursive: true, mode: 0o700 });
}

export async function writeWalEntry(entry: WalEntry): Promise<void> {
  const finalPath = entryPath(entry.requestId);
  await ensureDir();
  const tmpPath = `${finalPath}.tmp`;
  const body = `${JSON.stringify(entry)}\n`;
  try {
    await writeFile(tmpPath, body, { mode: 0o600 });
    await rename(tmpPath, finalPath);
  } catch (err) {
    logger.error({ err, requestId: entry.requestId }, 'Failed to write WAL entry');
    throw err;
  }
}

/** @internal */
export async function readWalEntries(): Promise<WalEntry[]> {
  await ensureDir();
  let names: string[];
  try {
    names = await readdir(walDir());
  } catch (err) {
    logger.warn({ err }, 'Failed to list WAL directory');
    return [];
  }
  const entries: WalEntry[] = [];
  for (const name of names) {
    if (!name.startsWith('unbilled-') || !name.endsWith('.json')) continue;
    try {
      const text = await readFile(join(walDir(), name), 'utf8');
      entries.push(JSON.parse(text) as WalEntry);
    } catch (err) {
      logger.warn({ err, name }, 'Failed to read WAL entry; skipping');
    }
  }
  return entries;
}

/** @internal */
export async function removeWalEntry(requestId: string): Promise<void> {
  try {
    await unlink(entryPath(requestId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err, requestId }, 'Failed to remove WAL entry');
    }
  }
}
