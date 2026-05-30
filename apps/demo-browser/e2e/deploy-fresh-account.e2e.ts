/**
 * M9 regression: deploying a NON-default account index must reach the on-device
 * deploy review (i.e. BEGIN_DEPLOY_ACCOUNT succeeds). This guards the gap that
 * shipped the 0x6F03 bug — the canonical-path check in begin_deploy_account.c
 * read the session length field before it was assigned, rejecting EVERY
 * canonical deploy. No e2e covered a deploy after that change (smoke + the M8
 * deploy-review test both use account #0, which is already on-chain and so
 * hides the Deploy button).
 *
 * We pick account #1 (fresh on testnet) and only drive up to the review screen —
 * we do NOT approve/submit, so #1 stays undeployed and the test is repeatable.
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

async function onboardAccount(page: Page, index: number): Promise<string> {
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  /* Select the non-default account index BEFORE deriving (OnboardPanel selector). */
  await expect(page.locator('#account-index')).toBeVisible({ timeout: 30_000 });
  await page.locator('#account-index').selectOption(String(index));
  const derive = page.getByRole('button', { name: /Derive .* viewing keys/ });
  await derive.click();
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 4; i++) await press('right');
  await press('both', 900);
  await page.waitForFunction(
    () => !!document.querySelector('.address') || !!document.querySelector('.status.err'),
    { timeout: 120_000 },
  );
  return (await page.locator('.address').first().innerText()).trim();
}

test('deploy a fresh account index reaches the device review (no 0x6F03)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  const addr = await onboardAccount(page, 1);
  console.log('[deploy-fresh] onboarded account #1 = ' + addr);

  const deployBtn = page.getByRole('button', { name: /Deploy account/ });
  await expect(deployBtn, 'account #1 must be undeployed (Deploy button present)').toBeVisible({
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
  console.log('\n=== DEPLOY-FRESH RESULT ===');
  console.log('deployReviewSeen=' + deployReviewSeen);
  console.log('errorBanner=' + JSON.stringify(errText));
  console.log('speculos screens:\n  ' + seen.map((s, i) => `${i}: ${s}`).join('\n  '));
  console.log('=== END ===\n');

  /* The bug surfaced as SW=0x6f03 on BEGIN_DEPLOY_ACCOUNT → review never appears. */
  expect(errText, 'must not fail with the path-scheme SW').not.toMatch(/0x6f03/i);
  expect(deployReviewSeen, 'device deploy review must appear for a fresh account').toBe(true);
});
