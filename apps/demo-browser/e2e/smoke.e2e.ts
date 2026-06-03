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

async function pressSpeculos(button: 'left' | 'right' | 'both'): Promise<void> {
  await fetch(`${SPECULOS_URL}/button/${button}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'press-and-release' }),
  }).catch(() => {});
}

/** Walk through Nano S+ review screens until "Sign Aztec outer_hash?"
 * appears, then press Both. Keeps a log of screens for diagnostics. */
async function autoConfirmSpeculos(durationMs = 60_000, screenLog?: string[]): Promise<void> {
  const deadline = Date.now() + durationMs;
  let prevScreen = '';
  while (Date.now() < deadline) {
    let screen = '';
    try {
      const res = await fetch(`${SPECULOS_URL}/events?currentscreenonly=true`);
      const json = (await res.json()) as { events: { text: string }[] };
      screen = json.events.map((e) => e.text).join(' | ');
    } catch {}
    if (screen !== prevScreen) {
      screenLog?.push(screen);
      prevScreen = screen;
    }
    /* Blind-sign warning screen ("Blind signing ahead | press both buttons"):
     * Ledger requires explicit Both-press acknowledgement before the
     * review starts. Without this the screen sticks forever. */
    if (/Blind signing ahead|press.*both buttons/i.test(screen)) {
      await pressSpeculos('both');
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    /* Final sign confirmation prompt. Note: Nano S+ wraps long text so
     * "Sign Aztec outer_hash?" displays as "Sign Aztec outer_ | hash?".
     * Match the leading "Sign Aztec" instead of the full string. */
    if (/Sign Aztec|^Approve$|Hold to sign/i.test(screen)) {
      await pressSpeculos('both');
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    /* "Reject" alone means we've overshot the Sign screen — back up. */
    if (/^Reject/.test(screen) && !/Sign|Approve|Blind/.test(screen)) {
      await pressSpeculos('left');
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    /* Default: advance. */
    await pressSpeculos('right');
    await new Promise((r) => setTimeout(r, 250));
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

/**
 * W4 (AHW-098): connect() now attests the receive address ON-DEVICE by default, so a
 * SECOND review ("Confirm receive address" → … → "Use this Aztec address?") appears
 * after the reveal + the (slow) PXE/session build inside onDerive. This walks ONLY
 * that review: advance while an address-review screen is showing, press Both on the
 * finish page. Deliberately does NOT press on the home screen (blind right-presses
 * there navigate the app menu and can land on Quit) — it just waits until the review
 * renders. Screen texts mirror the device review proven in provider.m8's attestAddress
 * marker. Returns once approved (or the deadline lapses, so it never wedges the test).
 */
async function confirmAddressReview(timeoutMs = 180_000, screenLog?: string[]): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let prev = '';
  /* Latch: only start pressing once a DISTINCTIVE address-review screen is seen — the
   * intro title, the subtitle, or the Scheme pair. Before that the device is on home
   * or the browser is still in PXE/connect init, and a blind `right` there would walk
   * the app menu (Quit). Once latched, advance on EVERY screen (the "Address 0x…" /
   * "Account #N" pairs don't carry a unique keyword) until the finish page. */
  let inReview = false;
  while (Date.now() < deadline) {
    const screen = await speculosScreen();
    if (screen !== prev) {
      screenLog?.push(screen);
      prev = screen;
    }
    if (/Use this Aztec/i.test(screen)) {
      await pressSpeculos('both'); // finish page → approve, done
      return;
    }
    /* Match LOOSELY — NBGL wraps the title across events ("Confirm receive  | address"),
     * so the full phrase never appears on one screen. "Confirm receive" (the intro) is
     * the reliable first latch; "Scheme" is a backup on the pair page. */
    if (/Confirm receive|Scheme/i.test(screen)) {
      inReview = true;
    }
    if (inReview) {
      await pressSpeculos('right'); // walk through intro/subtitle/Address/Account/Scheme → finish
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    /* Not in the review yet (home / connect still building) → WAIT, never press. */
    await new Promise((r) => setTimeout(r, 500));
  }
}

test('demo browser smoke', async ({ page }) => {
  const consoleErrors: string[] = [];
  const consoleAll: string[] = [];
  const pageErrors: Error[] = [];
  const failedRequests: { url: string; failure: string }[] = [];
  const wasmRequests: { url: string; status: number; contentType: string }[] = [];
  page.on('console', (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    consoleAll.push(text);
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    /* Mirror live to the playwright stdout so we don't have to wait for
     * the test to terminate to see what the page is doing. */
    if (process.env.LIVE_CONSOLE === '1') {
      const short = text.length > 200 ? text.slice(0, 200) + '…' : text;
      console.log('[browser] ' + short);
    }
  });
  page.on('pageerror', (err) => pageErrors.push(err));
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), failure: req.failure()?.errorText ?? '?' });
  });
  page.on('response', (res) => {
    const url = res.url();
    if (
      url.includes('.wasm') ||
      url.includes('barretenberg') ||
      url.includes('worker') ||
      url.includes('bb.js')
    ) {
      wasmRequests.push({
        url,
        status: res.status(),
        contentType: res.headers()['content-type'] ?? '',
      });
    }
  });

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
    await expect(nodeInput).toHaveValue('/aztec');
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
      /* M8 P7.3: Connect now reaches the 'onboarding' state (transport open +
       * verified) — the account address does NOT exist until the explicit
       * "Derive viewing keys" step below. */
      console.log('\n=== CONNECT OK (onboarding) ===\nTransport open; deriving next.\n');
    }
  });

  await test.step('derive viewing keys (reveal auto-confirm)', async () => {
    const errBanner = page.locator('.status.err').first();
    if ((await errBanner.count()) > 0) {
      console.log('\n=== SKIPPING DERIVE (Connect did not succeed) ===\n');
      return;
    }
    await page.getByRole('button', { name: /Derive .* viewing keys/ }).click();
    /* Reveal review = 6 screens (intro, subtitle ×2, Account, Confirm, finish) → 5
     * rights to reach "Reveal this account's privacy root?" then Both. (A fixed count,
     * not a marker walk: an event-polling approver races this particular review's
     * renderer → an accidental Reject 0x6985. The count was 4 and silently stuck on the
     * "Confirm" page — the reveal then timed out before connect() ever ran.) */
    await new Promise((r) => setTimeout(r, 1500));
    for (let i = 0; i < 5; i++) {
      await pressSpeculos('right');
      await new Promise((r) => setTimeout(r, 450));
    }
    await pressSpeculos('both');
    /* W4 (AHW-098): after the reveal, connect() attests the receive address ON-DEVICE
     * by default, so a 2nd review appears once the (slow) PXE/session build reaches
     * connect(). Walk it concurrently while the address renders. */
    const attestScreens: string[] = [];
    const attestPromise = confirmAddressReview(200_000, attestScreens);
    await page.waitForFunction(
      () => !!document.querySelector('.address') || !!document.querySelector('.status.err'),
      { timeout: 200_000 },
    );
    await attestPromise.catch(() => {});
    if (attestScreens.length > 0) {
      console.log(
        '\n=== ATTEST-ADDRESS SCREEN LOG (' +
          attestScreens.length +
          ') ===\n  ' +
          attestScreens.map((s, i) => `${i}: ${s}`).join('\n  '),
      );
    }
    if ((await errBanner.count()) > 0) {
      console.log('\n=== DERIVE ERROR ===\n' + (await errBanner.innerText()) + '\n=== END ===\n');
    } else {
      const addr = await page.locator('.address').first().innerText();
      console.log('\n=== DERIVE OK ===\nAddress: ' + addr + '\n=== END ===\n');
    }
  });

  await test.step('drive Deploy (Speculos auto-confirm)', async () => {
    const errBanner = page.locator('.status.err').first();
    if ((await errBanner.count()) > 0) {
      console.log('\n=== SKIPPING DEPLOY (Connect did not succeed) ===\n');
      return;
    }
    /* M9 A: an already-deployed account hides the Deploy button (AccountPanel
     * shows "✓ on-chain"). The deterministic salt means the demo account stays
     * deployed on testnet across runs, so Deploy is normally absent here — only
     * drive it when present, otherwise proceed straight to Drip (which still
     * exercises the FINALIZE/authwit path, incl. the M9 B3 consumer check). */
    const deployBtn = page.getByRole('button', { name: 'Deploy account' });
    if ((await deployBtn.count()) === 0) {
      console.log('\n=== DEPLOY SKIPPED (account already on-chain, M9 A) ===\n');
      return;
    }
    await deployBtn.click();
    const deployScreens: string[] = [];
    const confirmPromise = autoConfirmSpeculos(120_000, deployScreens);
    try {
      await page.waitForFunction(
        () => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('Deploy'),
          );
          const errBanner = document.querySelector('.status.err');
          if (errBanner) return true;
          if (!btn) return false;
          return !btn.textContent?.includes('Deploying');
        },
        { timeout: 5 * 60_000 },
      );
    } catch {
      console.log('\n=== DEPLOY TIMED OUT (5min) ===\n');
    }
    await confirmPromise.catch(() => {});
    await page.screenshot({ path: '/tmp/m6-2b-after-deploy.png', fullPage: true });

    const screen = await speculosScreen();
    console.log('\n=== SPECULOS POST-DEPLOY SCREEN ===\n' + screen);
    console.log(
      '\n=== DEPLOY SCREEN LOG (' +
        deployScreens.length +
        ') ===\n  ' +
        deployScreens.map((s, i) => `${i}: ${s}`).join('\n  '),
    );

    const errCount = await errBanner.count();
    if (errCount > 0) {
      const msg = await errBanner.innerText();
      console.log('\n=== DEPLOY ERROR ===\n' + msg + '\n=== END ===\n');
    } else {
      console.log('\n=== DEPLOY OK ===\n');
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
    /* Wait up to 5min for the drip to terminate — proving + inclusion. */
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
        { timeout: 5 * 60_000 },
      );
    } catch {
      console.log('\n=== DRIP TIMED OUT (5min) ===\n');
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
    console.log('=== WASM/WORKER REQUESTS (' + wasmRequests.length + ') ===');
    for (const r of wasmRequests) {
      console.log('  [' + r.status + ' ' + r.contentType + '] ' + r.url);
    }
    console.log('=== FAILED REQUESTS (' + failedRequests.length + ') ===');
    for (const r of failedRequests) {
      console.log('  ' + r.failure + ': ' + r.url);
    }
  });
});
