/**
 * M8 P8.1 — "reconnect == recovery" hero proof (headless).
 *
 * The cryptographic heart of M8: the Ledger IS the wallet and its own backup.
 * This proves it without the slow deploy/testnet path:
 *
 *   onboard (reveal → device secret + deterministic salt → account A)
 *   → "Forget session" (wipe the only persisted artifact, the secret cache)
 *   → reload (ephemeral PXE is in-memory → genuinely empty browser)
 *   → onboard again (cache cleared ⇒ FRESH device reveal → account B)
 *   → assert A === B, byte-for-byte.
 *
 * Same address after a full wipe = the device deterministically re-derived the
 * account from its seed. That's what makes "lose the laptop, plug the Ledger
 * back in, you're in" true. (The full deploy→drip→balance-reappears flow is the
 * guided run; the address identity is the part that must be machine-verified.)
 *
 * Pre-reqs: Speculos :5001 (M8 app.elf), Vite :5173, testnet RPC via /aztec.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

const SPECULOS_URL = 'http://localhost:5001';

async function press(button: 'left' | 'right' | 'both', ms = 450): Promise<void> {
  await fetch(`${SPECULOS_URL}/button/${button}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'press-and-release' }),
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, ms));
}

/** Connect → Derive viewing keys → approve the reveal on Speculos (blind
 * 4×right + both, per phase-6/7 lessons) → return the rendered account address. */
async function onboardOnce(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const derive = page.getByRole('button', { name: /Derive .* viewing keys/ });
  await expect(derive).toBeVisible({ timeout: 30_000 });
  await derive.click();
  await new Promise((r) => setTimeout(r, 1500)); // let the reveal screen render
  for (let i = 0; i < 4; i++) await press('right');
  await press('both', 900);
  await page.waitForFunction(
    () => !!document.querySelector('.address') || !!document.querySelector('.status.err'),
    { timeout: 120_000 },
  );
  const err = page.locator('.status.err').first();
  if ((await err.count()) > 0) throw new Error('onboard failed: ' + (await err.innerText()));
  return (await page.locator('.address').first().innerText()).trim();
}

test('reconnect == recovery: wipe + reconnect reproduces the same account', async ({ page }) => {
  await page.goto('/');

  const addrA = await test.step('onboard #1 → account A', () => onboardOnce(page));
  console.log('[reconnect] addrA = ' + addrA);

  await test.step('Forget session (wipe the secret cache) + reload', async () => {
    await page.getByRole('button', { name: 'Forget session' }).click();
    // Back to idle → Connect re-enabled.
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled({
      timeout: 10_000,
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: '1.5 Derive viewing keys' })).toBeVisible();
  });

  const addrB = await test.step('onboard #2 (fresh device reveal) → account B', () =>
    onboardOnce(page));
  console.log('[reconnect] addrB = ' + addrB);

  await test.step('A === B (device deterministically re-derived the account)', () => {
    expect(addrB).toMatch(/^0x[0-9a-fA-F]{10,}/);
    expect(addrB).toBe(addrA);
  });
});
