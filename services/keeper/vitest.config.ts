import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
