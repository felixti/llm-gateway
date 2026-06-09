import { createAzureUsageQueue } from './azure-queue';
import { createMemoryUsageQueue } from './memory-queue';
import type { UsageQueue } from './types';

export { createAzureUsageQueue } from './azure-queue';
export { createMemoryUsageQueue } from './memory-queue';
export type { QueueMessage, UsageQueue } from './types';

export function createUsageQueue(): UsageQueue {
  if (process.env.USAGE_QUEUE === 'azure' && process.env.AZURE_STORAGE_CONNECTION_STRING) {
    return createAzureUsageQueue(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
      process.env.USAGE_QUEUE_NAME ?? 'usage-events',
    );
  }
  return createMemoryUsageQueue();
}
