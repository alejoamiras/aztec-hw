/**
 * M8 deploy-fix validation (headless). After the ordering fix (override
 * installed BEFORE getDeployMethod, per pass), the spy pass should capture the
 * outer_hash and the flow should advance to the on-device deploy review.
 *
 * We don't drive full proving/inclusion (the guided run); the fix is confirmed
 * once we get PAST "did not capture" — i.e. a deploy review screen appears on
 * Speculos (spy captured → createAuthWitForDeploy reached the device). The
 * headless env can still time out on testnet node fetches inside request()
 * (an external fetch wrapper, not Aztec) — that's an env limitation, not the fix.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { confirmAddressReview, revealApprove } from './onboard-speculos.ts';

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

async function onboardOnce(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const derive = page.getByRole('button', { name: /Derive .* viewing keys/ });
  await expect(derive).toBeVisible({ timeout: 30_000 });
  await derive.click();
  await revealApprove(SPECULOS_URL); // reveal review (6 screens → 5 rights + both)
  // W4 (AHW-098): connect() then attests the receive address — walk that 2nd review.
  const attestPromise = confirmAddressReview(SPECULOS_URL, 200_000);
  await page.waitForFunction(
    () => !!document.querySelector('.address') || !!document.querySelector('.status.err'),
    { timeout: 200_000 },
  );
  await attestPromise.catch(() => {});
  return (await page.locator('.address').first().innerText()).trim();
}

test('deploy fix: spy captures → device deploy review appears (past "did not capture")', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  console.log('[deploy-fix] onboarded ' + (await onboardOnce(page)));

  await page.getByRole('button', { name: /Deploy account/ }).click();

  /* Poll (don't press) until the device shows the deploy review. When the spy
   * pass captures the hash, createAuthWitForDeploy sends BEGIN_DEPLOY_ACCOUNT,
   * which pushes the "Deploy Aztec account" review onto the device — that's the
   * fix signal. (No need to fully approve → proving/inclusion is the guided run.) */
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
    if (/Deploy Aztec|Sign Aztec|Hold to|Review transaction/i.test(s)) {
      deployReviewSeen = true;
      break;
    }
    if ((await page.locator('.status.err').first().count()) > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const errBanner = page.locator('.status.err').first();
  const errText = (await errBanner.count()) > 0 ? await errBanner.innerText() : '';
  console.log('\n=== DEPLOY-FIX RESULT ===');
  console.log('deployReviewSeen=' + deployReviewSeen);
  console.log('errorBanner=' + JSON.stringify(errText));
  console.log('consoleErrors=' + JSON.stringify(errors.slice(-5)));
  console.log('speculos screens seen:\n  ' + seen.map((s, i) => `${i}: ${s}`).join('\n  '));
  console.log('=== END ===\n');

  // The fix is confirmed if we did NOT hit "did not capture".
  const didNotCapture =
    errText.includes('did not capture') || errors.some((e) => e.includes('did not capture'));
  expect(didNotCapture, 'spy must capture the outer_hash after the ordering fix').toBe(false);
});
