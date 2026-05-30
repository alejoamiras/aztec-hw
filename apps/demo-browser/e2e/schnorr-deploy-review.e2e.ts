/**
 * M10 — the device deploy-Schnorr path. Onboarding a SchnorrAccount and clicking
 * Deploy must reach the on-device deploy review, which proves BEGIN_DEPLOY_ACCOUNT
 * with curve_id=GRUMPKIN + profile 1 succeeds end-to-end: the (curve_id, profile
 * arg_schema) pairing, the Schnorr Grumpkin pubkey derivation, the 2-Fr partial
 * address, and the M8-P6 device-derived address verify all pass. A Schnorr account
 * is a DISTINCT account from the ECDSA one at the same index (different account
 * contract → different address), so Schnorr #0 is fresh on testnet and the Deploy
 * button shows. We drive only up to the review (no approve/submit) so it stays
 * undeployed + the test is repeatable. The finalize_deploy Schnorr SIGN itself is
 * parity-locked (schnorr-parity: byte-exact + verifies under barretenberg).
 *
 * Mirrors deploy-fresh-account.e2e.ts; the only delta is selecting the Schnorr
 * scheme before deriving.
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

async function screen(): Promise<string> {
  try {
    const res = await fetch(`${SPECULOS_URL}/events?currentscreenonly=true`);
    const json = (await res.json()) as { events: { text: string }[] };
    return json.events.map((e) => e.text).join(' | ');
  } catch {
    return '';
  }
}

async function onboardSchnorr(page: Page, index: number): Promise<string> {
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('#account-index')).toBeVisible({ timeout: 30_000 });
  /* M10: pick the Schnorr scheme BEFORE deriving so connect() builds the
   * SchnorrAccount + a curve_id=GRUMPKIN provider. */
  await page.locator('#scheme').selectOption('schnorr');
  await page.locator('#account-index').selectOption(String(index));
  const derive = page.getByRole('button', { name: /Derive .* viewing keys/ });
  await derive.click();
  await new Promise((r) => setTimeout(r, 1500));
  /* Single reveal approval (viewing keys are scheme-independent); GET_SCHNORR_PUBKEY
   * is a silent derivation INS. */
  for (let i = 0; i < 4; i++) await press('right');
  await press('both', 900);
  await page.waitForFunction(
    () => !!document.querySelector('.address') || !!document.querySelector('.status.err'),
    { timeout: 120_000 },
  );
  return (await page.locator('.address').first().innerText()).trim();
}

test('deploy a Schnorr account reaches the device review (curve_id=GRUMPKIN)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  const addr = await onboardSchnorr(page, 0);
  console.log('[schnorr-deploy] onboarded Schnorr #0 = ' + addr);

  const deployBtn = page.getByRole('button', { name: /Deploy account/ });
  await expect(deployBtn, 'Schnorr #0 must be undeployed (Deploy button present)').toBeVisible({
    timeout: 15_000,
  });
  await deployBtn.click();

  const seen: string[] = [];
  let deployReviewSeen = false;
  let prev = '';
  const deadline = Date.now() + 110_000;
  while (Date.now() < deadline && !deployReviewSeen) {
    const s = await screen();
    if (s && s !== prev) {
      seen.push(s);
      prev = s;
    }
    if (/Deploy Aztec|Account #|Sign Aztec|Hold to|Review transaction/i.test(s)) {
      deployReviewSeen = true;
      break;
    }
    if ((await page.locator('.status.err').first().count()) > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const errBanner = page.locator('.status.err').first();
  const errText = (await errBanner.count()) > 0 ? await errBanner.innerText() : '';
  console.log('\n=== SCHNORR-DEPLOY-REVIEW RESULT ===');
  console.log('deployReviewSeen=' + deployReviewSeen);
  console.log('errorBanner=' + JSON.stringify(errText));
  console.log('speculos screens:\n  ' + seen.map((s, i) => `${i}: ${s}`).join('\n  '));
  console.log('=== END ===\n');

  /* A device reject of the GRUMPKIN curve / (curve,profile) pair surfaces as a 0x6Fxx
   * SW; the Schnorr deploy review must appear instead. */
  expect(errText, 'must not fail with a device SW').not.toMatch(/0x6f[0-9a-f]{2}/i);
  expect(deployReviewSeen, 'Schnorr deploy review must appear on device').toBe(true);
});
