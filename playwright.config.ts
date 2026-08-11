import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests.
 *
 * These drive the real app in a real browser against real DuckDB WASM, which is
 * the only place several of this app's failure modes are visible at all: SQL
 * that compiles but will not run, a route guard that redirects before the
 * capture has finished loading, a layout that only breaks below a breakpoint.
 * The unit tests under tests/lib cover the parsers; these cover the app.
 *
 * On NixOS the browsers Playwright downloads will not run — see README. Set
 * PLAYWRIGHT_BROWSERS_PATH to the nixpkgs build instead.
 *
 * CHROMIUM_PATH is the blunter version of the same escape hatch, for an
 * environment that ships a working Chromium but not the exact revision this
 * Playwright expects, and cannot download the one it wants. Point it at the
 * binary and the revision lookup is skipped entirely.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Named .e2e.ts rather than .spec.ts so `bun test` — which claims *.spec.*
  // — cannot pick these up and try to run them without a browser.
  testMatch: '**/*.e2e.ts',
  // Every spec loads a capture and drives one screen; they share nothing.
  fullyParallel: true,
  // A test that only passes sometimes is worse than no test, so a retry in CI
  // is a report of flakiness rather than a way to hide it.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  expect: {
    // DuckDB has to instantiate before the first filter resolves.
    timeout: 15_000,
  },
  use: {
    baseURL: 'http://localhost:5173/bgpshark/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:5173/bgpshark/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
