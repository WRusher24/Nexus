import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
    setupFiles: ['src/test/helpers/setup.ts'],
    pool: 'forks',
    testTimeout: 30000,
  },
});
