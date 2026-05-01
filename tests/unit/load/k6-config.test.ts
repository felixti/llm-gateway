import { describe, expect, it } from 'bun:test';

describe('k6 load-test config', () => {
  it('uses the configured default model alias', async () => {
    const loadConfig = await Bun.file('tests/load/k6.config.ts').text();
    const model = loadConfig.match(/model:\s*'([^']+)'/)?.[1];

    expect(model).toBe('gpt-4.1-mini');
  });
});
