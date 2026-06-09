import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs typescript under vitest', () => {
    const x: number = 1 + 1;
    expect(x).toBe(2);
  });
});
