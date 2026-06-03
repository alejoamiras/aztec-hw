/**
 * M8 P7.3 — onboarding smoke (headless).
 *
 * Proves the device-secret onboarding works in the real browser:
 *   load → Connect (opens + verifies transport) → "Derive viewing keys"
 *   (reveal GET_AZTEC_MASTER_SECRET, approved on Speculos) → the session is
 *   built FROM the device secret + deterministic salt, and the account address
 *   renders.
 *
 * This is the in-browser counterpart to provider.m8.test.ts (which proves the
 * device ACCEPTS the device-derived account). The slow deploy→drip→testnet path
 * is intentionally NOT exercised here — that's the P8.1 hero / guided run.
 *
 * Pre-reqs: Speculos at :5001 with the M8 app.elf; Vite at :5173; testnet RPC
 * reachable via the /aztec proxy (connect() does an initial PXE sync).
 */
import { expect, test } from '@playwright/test';
import { confirmAddressReview, revealApprove, speculosScreen } from './onboard-speculos.ts';

const SPECULOS_URL = 'http://localhost:5001';

test('onboarding: connect → derive viewing keys → session address renders', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await test.step('page loads with the onboarding panel', async () => {
    const resp = await page.goto('/');
    expect(resp?.ok()).toBe(true);
    await expect(page.getByRole('heading', { name: '1.5 Derive viewing keys' })).toBeVisible();
  });

  await test.step('Connect opens + verifies the device → onboarding state', async () => {
    await page.getByRole('button', { name: 'Connect' }).click();
    // The OnboardPanel's derive button only appears once state === 'onboarding'
    // (transport open + GET_VERSION ok). Generous timeout for transport open.
    await expect(page.getByRole('button', { name: /Derive .* viewing keys/ })).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step('Derive viewing keys (reveal approved on Speculos)', async () => {
    await page.getByRole('button', { name: /Derive .* viewing keys/ }).click();

    const before = await speculosScreen(SPECULOS_URL);
    console.log('[onboard] reveal screen before approve: ' + before);
    await revealApprove(SPECULOS_URL); // reveal review: 5 rights + both (6-screen review)

    /* After the reveal, connect() attests the receive address ON-DEVICE by default
     * (W4 AHW-098) — a 2nd review. Walk it concurrently while connect() builds the PXE
     * + syncs, then the AccountPanel renders `.address`. Wait for address OR an error. */
    const attestScreens: string[] = [];
    const attestPromise = confirmAddressReview(SPECULOS_URL, 200_000, attestScreens);
    await page.waitForFunction(
      () => !!document.querySelector('.address') || !!document.querySelector('.status.err'),
      { timeout: 200_000 },
    );
    await attestPromise.catch(() => {});
    if (attestScreens.length > 0) {
      console.log('[onboard] attest-address screens: ' + JSON.stringify(attestScreens));
    }
  });

  await test.step('assert the session is built from the device secret', async () => {
    const err = page.locator('.status.err').first();
    if ((await err.count()) > 0) {
      const msg = await err.innerText();
      console.log('=== ONBOARD ERROR ===\n' + msg);
      console.log('=== CONSOLE ERRORS ===\n' + consoleErrors.join('\n'));
      throw new Error('Onboarding failed: ' + msg);
    }
    const addr = await page.locator('.address').first().innerText();
    console.log('=== ONBOARD OK === address=' + addr);
    expect(addr).toMatch(/^0x[0-9a-fA-F]{10,}/);
    // OnboardPanel flips to the derived-confirmation once the session is ready.
    await expect(page.getByText(/Viewing keys derived on-device/)).toBeVisible();
  });
});
