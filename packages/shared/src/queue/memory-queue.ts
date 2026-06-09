import { randomUUID } from 'node:crypto';

import type { QueueMessage, UsageQueue } from './types';

interface MemoryMessage {
  id: string;
  body: string;
  popReceipt: string;
  dequeueCount: number;
  invisibleUntilMs: number;
}

export function createMemoryUsageQueue(): UsageQueue {
  const messages: MemoryMessage[] = [];

  function visible(now: number, message: MemoryMessage): boolean {
    return message.invisibleUntilMs <= now;
  }

  return {
    async enqueue(body: string): Promise<void> {
      messages.push({
        id: randomUUID(),
        body,
        popReceipt: randomUUID(),
        dequeueCount: 0,
        invisibleUntilMs: 0,
      });
    },

    async receive(maxMessages: number, visibilityTimeoutSec: number): Promise<QueueMessage[]> {
      const now = Date.now();
      const limit = Math.max(1, maxMessages);
      const selected: MemoryMessage[] = [];

      for (const message of messages) {
        if (selected.length >= limit) break;
        if (!visible(now, message)) continue;
        message.dequeueCount += 1;
        message.invisibleUntilMs = now + visibilityTimeoutSec * 1000;
        message.popReceipt = randomUUID();
        selected.push(message);
      }

      return selected.map(({ id, popReceipt, body, dequeueCount }) => ({
        id,
        popReceipt,
        body,
        dequeueCount,
      }));
    },

    async deleteMessage(id: string, popReceipt: string): Promise<void> {
      const index = messages.findIndex(
        (message) => message.id === id && message.popReceipt === popReceipt,
      );
      if (index === -1) {
        throw new Error(`Queue message not found: ${id}`);
      }
      messages.splice(index, 1);
    },
  };
}
