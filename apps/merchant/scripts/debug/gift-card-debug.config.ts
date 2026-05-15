/**
 * Minimal Playwright config for live-server gift card debugging.
 * Targets https://dev.kizo.example — no local test server needed.
 *
 * Run: GC_DEBUG_MODE=1 bunx playwright test scripts/debug/gift-card-debug.ts \
 *        --config scripts/debug/gift-card-debug.config.ts --headed
 */
import { defineConfig, devices } from '@playwright/test'
import { mkdirSync } from 'node:fs'

mkdirSync('scripts/debug/screenshots', { recursive: true })

export default defineConfig({
  testDir: '.',
  testMatch: '**/gift-card-debug.ts',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: 'list',

  use: {
    baseURL: 'https://dev.kizo.example',
    ...devices['Pixel 5'],
    serviceWorkers: 'allow',  // allow SW — mirrors real user experience
    screenshot: 'on',
    video:      'retain-on-failure',
    trace:      'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium-debug',
      use: { ...devices['Pixel 5'] },
    },
  ],
})
