import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config (M9, Part 7.1).
 *
 * The smoke test is a manual pre-deployment check, not a CI gate: it makes live
 * Wikipedia + LLM calls and is slow/expensive. CI keeps running the Vitest
 * suite (fixture-backed) instead.
 *
 * `webServer` boots the Next.js dev server with test auth settings;
 * `globalSetup` optionally spawns the worker (needed for real expansions).
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/fixtures/global-setup.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      E2E_TEST_AUTH: '1',
      ALLOWED_EMAILS: 'test@example.com',
      ADMIN_EMAILS: 'test@example.com',
      EMAIL_PROVIDER: 'console',
    },
  },
});
