/**
 * Playwright config — pattern lifted from
 * aztec-accelerator/packages/playground/playwright.config.ts. Vite is
 * spawned by Playwright itself via `webServer.command`; we reuse an
 * existing dev server if it's already up.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  /* Drip flow can take many minutes (PXE sync + proving + on-chain
   * inclusion). 15min covers a slow alpha-testnet run with both
   * deploy + drip submitted. */
  timeout: 15 * 60_000,
  webServer: {
    command: 'bun run dev',
    port: 5173,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  use: {
    baseURL: 'http://localhost:5173',
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
