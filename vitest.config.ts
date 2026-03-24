import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 60_000, // AI calls can be slow
    hookTimeout: 30_000,
    env: { DOTENV_CONFIG_PATH: './.env.local' },
    setupFiles: ['dotenv/config'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/web/**', 'src/**/__tests__/**', 'src/**/*.test.ts'],
      thresholds: {
        lines: 15,
        functions: 15,
        branches: 14,
        statements: 15,
      },
    },
  },
});
