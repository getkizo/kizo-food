import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright e2e test configuration for the Kizo customer store PWA.
 *
 * Architecture:
 *   - webServer: starts a Bun test server on port 3099 with a fresh SQLite DB
 *   - globalSetup: seeds the DB with a test merchant + menu via the API
 *   - globalTeardown: removes the test DB file
 *   - workers: 1 (serial) — all specs share the same running server + DB
 *   - serviceWorkers: 'block' — prevents SW caching from interfering with tests
 *
 * Run: bunx playwright test
 * Debug: bunx playwright test --headed --debug
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,           // serial — shared DB state
  reporter: 'list',
  fullyParallel: false,

  use: {
    baseURL: 'http://127.0.0.1:3099',

    // Mobile viewport — Pixel 5 (realistic for a restaurant PWA)
    ...devices['Pixel 5'],

    // Block SW so tests aren't affected by cache versioning
    serviceWorkers: 'block',

    // Capture on failure
    screenshot: 'only-on-failure',
    video:      'retain-on-failure',
    trace:      'retain-on-failure',
  },

  projects: [
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],

  globalSetup:    './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  webServer: {
    command: 'bun run e2e/test-server.ts',
    url:     'http://127.0.0.1:3099/health',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout:  'pipe',
    stderr:  'pipe',
  },
})
