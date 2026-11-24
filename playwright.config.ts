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
 *
 * E2E_PREVIEW=1 runs the suite against the production build (`vite build`,
 * served by `vite preview`) instead of the dev server. CI sets it, for two
 * reasons. The build is what the deployed site serves, CSP included — the dev
 * server ships no CSP, which is how a DuckDB extension download once passed
 * every spec here and broke the deployed SQL console (see offline.e2e.ts).
 * And it is faster: the dev server transforms each module on request, and
 * every spec opens a fresh page, so it pays that again for each one. Locally the
 * dev server stays the default so a spec can be rerun without a rebuild.
 */
const preview = Boolean(process.env.E2E_PREVIEW)
const baseURL = preview ? 'http://localhost:4173/bgpshark/' : 'http://localhost:5173/bgpshark/'

export default defineConfig({
  testDir: './tests/e2e',
  // Named .e2e.ts rather than .spec.ts so `bun test` — which claims *.spec.*
  // — cannot pick these up and try to run them without a browser.
  testMatch: '**/*.e2e.ts',
  // Every spec loads a capture and drives one screen; they share nothing.
  fullyParallel: true,
  // One worker per core in CI, rather than Playwright's default of half. A
  // spec used to start DuckDB on every capture it loaded, which kept a core
  // busy each and made more workers slower; DuckDB now starts only on the SQL
  // console, and on a 4-core machine the suite took 182s with two workers and
  // 101s with four. Locally the default stays, leaving room for the dev server.
  workers: process.env.CI ? '100%' : undefined,
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
    baseURL,
    // Pin English by default so existing specs stay deterministic on Japanese
    // host OSes; tests/e2e/i18n.e2e.ts overrides this to 'ja-JP' explicitly.
    locale: 'en-US',
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
    // `vite build` rather than `bun run build`: the type-check is the check
    // job's, and the bundle it emits is the same either way. --strictPort so a
    // stale server on 4173 fails loudly instead of being tested by mistake.
    command: preview ? 'bunx vite build && bunx vite preview --strictPort' : 'bun run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
