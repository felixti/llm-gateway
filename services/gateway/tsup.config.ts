import { defineConfig } from 'tsup';
import { resolve } from 'node:path';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  esbuildOptions(options) {
    options.alias = {
      '@shared': resolve(__dirname, '../../packages/shared/src'),
    };
  },
});
