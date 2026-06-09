import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMemoryConfigStore } from './memory-store';
import { createCachedConfigStore } from './cache';

describe('createCachedConfigStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('second getModel within TTL does not call underlying twice', async () => {
    const underlying = createMemoryConfigStore();
    const spy = vi.spyOn(underlying, 'getModel');
    const cached = createCachedConfigStore(underlying, { ttlMs: 60_000 });

    await cached.getModel('gpt-5.4');
    await cached.getModel('gpt-5.4');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('bumpConfigVersion invalidates cache and refetches', async () => {
    const underlying = createMemoryConfigStore();
    const spy = vi.spyOn(underlying, 'getModel');
    const cached = createCachedConfigStore(underlying);

    await cached.getModel('gpt-5.4');
    await underlying.bumpConfigVersion();
    await cached.getModel('gpt-5.4');

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetches after TTL expires', async () => {
    vi.useFakeTimers();
    const underlying = createMemoryConfigStore();
    const spy = vi.spyOn(underlying, 'getModel');
    const cached = createCachedConfigStore(underlying, { ttlMs: 1_000 });

    await cached.getModel('gpt-5.4');
    vi.advanceTimersByTime(1_001);
    await cached.getModel('gpt-5.4');

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
