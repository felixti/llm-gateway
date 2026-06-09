import { QueueClient } from '@azure/storage-queue';

import type { QueueMessage, UsageQueue } from './types';

export function createAzureUsageQueue(
  connectionString: string,
  queueName: string,
): UsageQueue {
  const client = new QueueClient(connectionString, queueName);

  return {
    async enqueue(body: string): Promise<void> {
      await client.sendMessage(body);
    },

    async receive(maxMessages: number, visibilityTimeoutSec: number): Promise<QueueMessage[]> {
      const response = await client.receiveMessages({
        numberOfMessages: Math.min(Math.max(1, maxMessages), 32),
        visibilityTimeout: visibilityTimeoutSec,
      });

      return (response.receivedMessageItems ?? []).map((item) => ({
        id: item.messageId ?? '',
        popReceipt: item.popReceipt ?? '',
        body: item.messageText ?? '',
        dequeueCount: item.dequeueCount ?? 0,
      }));
    },

    async deleteMessage(id: string, popReceipt: string): Promise<void> {
      await client.deleteMessage(id, popReceipt);
    },
  };
}
