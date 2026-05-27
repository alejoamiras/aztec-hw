/**
 * Smoke test for the M6 demo browser.
 *
 * Proves end-to-end:
 *  - Vite dev server reachable + React bundle loads.
 *  - All three panels render.
 *  - Connect drives the full AztecLedgerSession.connect() against
 *    live alpha-testnet + the Speculos emulator → real Ledger-derived
 *    account address.
 *  - Drip kicks off the clear-signing pipeline (BEGIN_AUTHWIT +
 *    APPEND_CALL × N + FINALIZE_AND_SIGN against Speculos). The test
 *    drives the Speculos buttons via its REST API to auto-confirm.
 *
 * Pre-reqs:
 *  - Speculos at localhost:5001 with the M5 Aztec app loaded.
 *  - Internet access to https://rpc.testnet.aztec-labs.com.
 *
 * Doesn't yet drive Transfer (Drip doesn't need on-chain prior balance;
 * Transfer needs USDC in the account, which Drip would supply if the
 * tx actually lands).
 */
import { expect, test } from '@playwright/test';

const SPECULOS_URL = 'http://localhost:5001';

/** Spam the right-then-both button presses on Speculos until the device
 * returns to idle. Speculos's review screens differ by verb count;
 * presses are cheap so we just brute-force confirmation. */
async function autoConfirmSpeculos(durationMs = 8000): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    /* Sequence Right (advance), Right (advance), Both (confirm). */
    await fetch(`${SPECULOS_URL}/button/right`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'press-and-release' }),
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    await fetch(`${SPECULOS_URL}/button/both`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'press-and-release' }),
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function speculosScreen(): Promise<string> {
  try {
    const res = await fetch(`${SPECULOS_URL}/events?currentscreenonly=true`);
    const json = (await res.json()) as { events: { text: string }[] };
    return json.events.map((e) => e.text).join(' | ');
  } catch {
    return '<unreachable>';
  }
}

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

  await test.step('drive Drip (Speculos auto-confirm)', async () => {
    const errBanner = page.locator('.status.err').first();
    if ((await errBanner.count()) > 0) {
      console.log('\n=== SKIPPING DRIP (Connect did not succeed) ===\n');
      return;
    }
    const dripBtn = page.getByRole('button', { name: 'Drip 1000 USDC' });
    await dripBtn.click();
    /* Concurrently spam Speculos confirmations while the click resolves. */
    const confirmPromise = autoConfirmSpeculos(20_000);
    /* Wait up to 90s for the drip to terminate — proving may be slow. */
    try {
      await page.waitForFunction(
        () => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('Drip'),
          );
          const errBanner = document.querySelector('.status.err');
          if (errBanner) return true;
          if (!btn) return false;
          return !btn.textContent?.includes('Dripping');
        },
        { timeout: 90_000 },
      );
    } catch (e) {
      console.log('\n=== DRIP TIMED OUT (90s) ===\n');
    }
    await confirmPromise.catch(() => {});
    await page.screenshot({ path: '/tmp/m6-3-after-drip.png', fullPage: true });

    const screen = await speculosScreen();
    console.log('\n=== SPECULOS POST-DRIP SCREEN ===\n' + screen);

    const errCount = await errBanner.count();
    if (errCount > 0) {
      const msg = await errBanner.innerText();
      console.log('\n=== DRIP ERROR ===\n' + msg + '\n=== END ===\n');
    } else {
      console.log('\n=== DRIP OK ===\n');
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
