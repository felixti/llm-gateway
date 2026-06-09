import { createCachedConfigStore } from './cache';
import { createMemoryConfigStore } from './memory-store';
import { createTableConfigStoreFromEnv } from './table-store';
import type { ConfigStore } from './types';

export function createConfigStore(): ConfigStore {
  if (process.env.CONFIG_STORE === 'table' && process.env.AZURE_TABLE_CONNECTION_STRING) {
    return createCachedConfigStore(createTableConfigStoreFromEnv());
  }
  return createCachedConfigStore(createMemoryConfigStore());
}

export type { ConfigStore } from './types';
export { createCachedConfigStore } from './cache';
export { createMemoryConfigStore } from './memory-store';
export { createTableConfigStore, createTableConfigStoreFromEnv } from './table-store';
