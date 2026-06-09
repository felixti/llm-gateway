import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryUsageQueue } from '@shared/queue/memory-queue';

describe('createMemoryUsageQueue', () => {
  it('enqueues and receives messages', async () => {
    const queue = createMemoryUsageQueue();
    await queue.enqueue('{"request_id":"req-1"}');

    const messages = await queue.receive(1, 30);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe('{"request_id":"req-1"}');
    expect(messages[0]?.dequeueCount).toBe(1);
  });

  it('hides messages until visibility timeout expires', async () => {
    const queue = createMemoryUsageQueue();
    await queue.enqueue('hidden');

    const first = await queue.receive(1, 1);
    expect(first).toHaveLength(1);

    const second = await queue.receive(1, 1);
    expect(second).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const third = await queue.receive(1, 1);
    expect(third).toHaveLength(1);
    expect(third[0]?.dequeueCount).toBe(2);
  });

  it('deletes messages by id and pop receipt', async () => {
    const queue = createMemoryUsageQueue();
    await queue.enqueue('done');

    const [message] = await queue.receive(1, 30);
    expect(message).toBeDefined();
    await queue.deleteMessage(message!.id, message!.popReceipt);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const remaining = await queue.receive(1, 1);
    expect(remaining).toHaveLength(0);
  });

  it('rejects delete when pop receipt mismatches', async () => {
    const queue = createMemoryUsageQueue();
    await queue.enqueue('keep');

    const [message] = await queue.receive(1, 30);
    expect(message).toBeDefined();

    await expect(queue.deleteMessage(message!.id, 'bad-receipt')).rejects.toThrow(
      /not found/,
    );
  });
});

describe('createUsageQueue factory', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns memory queue by default', async () => {
    delete process.env.USAGE_QUEUE;
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;

    const { createUsageQueue } = await import('@shared/queue/index');
    const queue = createUsageQueue();
    await queue.enqueue('memory');
    const messages = await queue.receive(1, 30);
    expect(messages[0]?.body).toBe('memory');
  });
});
