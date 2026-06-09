import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, '../../packages/shared/src') } },
  test: { globals: true, environment: 'node' },
});
