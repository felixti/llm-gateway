import { describe, expect, it } from 'bun:test';
import { AsyncMutex } from '../../../src/utils/mutex';

describe('AsyncMutex', () => {
  it('should allow sequential acquires', async () => {
    const mutex = new AsyncMutex();
    const release1 = await mutex.acquire();
    release1();
    const release2 = await mutex.acquire();
    release2();
  });

  it('should serialize concurrent acquires', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const p1 = (async () => {
      const release = await mutex.acquire();
      order.push(1);
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);
      release();
    })();

    const p2 = (async () => {
      const release = await mutex.acquire();
      order.push(3);
      release();
    })();

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('should handle multiple queued acquires', async () => {
    const mutex = new AsyncMutex();
    let counter = 0;

    const task = async () => {
      const release = await mutex.acquire();
      counter++;
      release();
    };

    await Promise.all([task(), task(), task()]);
    expect(counter).toBe(3);
  });
});