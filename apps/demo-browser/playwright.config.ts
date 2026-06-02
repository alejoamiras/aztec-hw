/**
 * Playwright config — pattern lifted from
 * aztec-accelerator/packages/playground/playwright.config.ts. Vite is
 * spawned by Playwright itself via `webServer.command`; we reuse an
 * existing dev server if it's already up.
 */
import { defineConfig, devices } from '@playwright/test';

/* DEMO_PORT lets the e2e run on a free port when the default 5173 is taken by an
 * unrelated dev server (e.g. a stale Vite from another project) — without killing it. */
const PORT = Number(process.env.DEMO_PORT ?? 5173);

export default defineConfig({
  testDir: './e2e',
  /* `.e2e.ts` (not `.spec.ts`) so bun:test's discovery doesn't pick
   * these up — @playwright/test's `test()` blows up when invoked by
   * the bun runner. */
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  /* Drip flow can take many minutes (PXE sync + proving + on-chain
   * inclusion). 15min covers a slow alpha-testnet run with both
   * deploy + drip submitted. */
  timeout: 15 * 60_000,
  webServer: {
    command: `bun run dev -- --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
