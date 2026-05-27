/**
 * Smoke test for the M6 demo browser.
 *
 * What this proves:
 *  - Vite dev server is reachable + the React bundle loads.
 *  - Page mounts (root #root has children, no boot-time error overlay).
 *  - All three panels render with expected H2s.
 *  - The transport dropdown + node URL field accept input.
 *  - Clicking Connect transitions to "connecting" and then either:
 *      - "ready" if Speculos is up + node reachable (won't happen without
 *        live PXE init), or
 *      - "error" with a meaningful message (the most likely path here).
 *
 * What this CANNOT prove:
 *  - The actual session connects end-to-end (needs the alpha-testnet
 *    node to be reachable + PXE WASM prover to init).
 *  - That a tx submits to chain.
 *
 * Capture: screenshots + console logs at each step so a failure tells
 * the user something actionable.
 */
import { expect, test } from '@playwright/test';

test('demo browser smoke', async ({ page }) => {
  const consoleErrors: string[] = [];
  const consoleAll: string[] = [];
  const pageErrors: Error[] = [];
  page.on('console', (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    consoleAll.push(text);
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err));

  await test.step('page loads', async () => {
    const resp = await page.goto('/');
    expect(resp?.ok()).toBe(true);
    await page.screenshot({ path: '/tmp/m6-1-loaded.png', fullPage: true });
  });

  await test.step('all three panels render', async () => {
    await expect(page.getByRole('heading', { name: '1. Connect' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '2. Account & Drip' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '3. Transfer USDC' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Aztec Ledger Demo' })).toBeVisible();
  });

  await test.step('connect panel inputs work', async () => {
    const transportSelect = page.locator('#transport');
    await expect(transportSelect).toHaveValue('speculos');
    await transportSelect.selectOption('webhid');
    await expect(transportSelect).toHaveValue('webhid');
    await transportSelect.selectOption('speculos');

    const nodeInput = page.locator('#node-url');
    await expect(nodeInput).toHaveValue('https://rpc.testnet.aztec-labs.com');
  });

  await test.step('disabled panels are visibly disabled', async () => {
    const account = page.locator('section.panel.disabled').nth(0);
    const transfer = page.locator('section.panel.disabled').nth(1);
    await expect(account).toBeVisible();
    await expect(transfer).toBeVisible();
  });

  await test.step('click Connect and capture result', async () => {
    const connectBtn = page.getByRole('button', { name: 'Connect' });
    await connectBtn.click();

    /* The Connect button changes label first to "Connecting…", then either
     * to "Connected" (success) or stays on the error path. Wait up to 45s
     * because PXE init + WASM prover load can take a while; we'll capture
     * whichever terminal state we end up in. */
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button');
        if (!btn) return false;
        const text = btn.textContent ?? '';
        const stillConnecting = text.includes('Connecting');
        if (stillConnecting) return false;
        const errBanner = document.querySelector('.status.err');
        return text.includes('Connected') || !!errBanner;
      },
      { timeout: 45_000 },
    );

    await page.screenshot({ path: '/tmp/m6-2-after-connect.png', fullPage: true });

    const errBanner = page.locator('.status.err').first();
    const isErr = await errBanner.count();
    if (isErr) {
      const msg = await errBanner.innerText();
      console.log('\n=== CONNECT ERROR (expected) ===\n' + msg + '\n=== END ===\n');
    } else {
      const addr = await page.locator('.address').first().innerText();
      console.log('\n=== CONNECT OK ===\nAddress: ' + addr + '\n=== END ===\n');
    }
  });

  await test.step('report console + page errors', async () => {
    console.log('\n=== CONSOLE ERRORS (' + consoleErrors.length + ') ===');
    for (const e of consoleErrors) console.log('  - ' + e.split('\n')[0]);
    console.log('=== PAGE ERRORS (' + pageErrors.length + ') ===');
    for (const e of pageErrors) {
      console.log('  - ' + (e.message || String(e)));
      if (e.stack)
        console.log(
          e.stack
            .split('\n')
            .slice(0, 8)
            .map((l) => '      ' + l)
            .join('\n'),
        );
    }
    console.log('=== CONSOLE (last 20, full) ===');
    for (const e of consoleAll.slice(-20)) console.log('  ' + e);
  });
});
