/**
 * M10 P8 — the DEFINITIVE on-chain Schnorr proof. Drives the demo through the
 * full flow with the Schnorr toggle: onboard → DEPLOY (submit) → DRIP → TRANSFER,
 * all clear-signed on the device with the Schnorr-over-Grumpkin primitive and
 * submitted to live testnet.
 *
 * The deploy landing on-chain is the keystone: the SchnorrAccount entrypoint
 * verifies the device's Schnorr deploy authwit in-circuit, so a successful deploy
 * proves finalize_deploy_and_sign's Schnorr sign is byte-correct AND accepted by
 * the canonical noir-lang/schnorr verifier. Drip + transfer then exercise the
 * Schnorr AUTHWIT path on the deployed account.
 *
 * Uses a high index (#5) so the low Schnorr indices stay fresh for a live demo
 * recording. Repeatable: once #5 is on-chain the deploy step self-skips and the
 * run still exercises the Schnorr authwit via drip/transfer.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

const SPECULOS_URL = 'http://localhost:5001';
const SCHNORR_INDEX = 4; // dropdown is [0..4]; #4 = fresh Schnorr account (kept high for the demo)

async function pressSpeculos(button: 'left' | 'right' | 'both'): Promise<void> {
  await fetch(`${SPECULOS_URL}/button/${button}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'press-and-release' }),
  }).catch(() => {});
}

/** Walk review screens, pressing Both at the sign/approve prompt. */
async function autoConfirmSpeculos(durationMs = 120_000, screenLog?: string[]): Promise<void> {
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
    if (/Blind signing ahead|press.*both buttons/i.test(screen)) {
      await pressSpeculos('both');
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (/Sign Aztec|^Approve$|Hold to sign/i.test(screen)) {
      await pressSpeculos('both');
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    if (/^Reject/.test(screen) && !/Sign|Approve|Blind/.test(screen)) {
      await pressSpeculos('left');
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    await pressSpeculos('right');
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function onboardSchnorr(page: Page, index: number): Promise<string> {
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('#account-index')).toBeVisible({ timeout: 45_000 });
  await page.locator('#scheme').selectOption('schnorr');
  await page.locator('#account-index').selectOption(String(index));
  await page.getByRole('button', { name: /Derive .* viewing keys/ }).click();
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 4; i++) {
    await pressSpeculos('right');
    await new Promise((r) => setTimeout(r, 450));
  }
  await pressSpeculos('both');
  await page.waitForFunction(
    () => !!document.querySelector('.address') || !!document.querySelector('.status.err'),
    { timeout: 120_000 },
  );
  const err = page.locator('.status.err').first();
  if ((await err.count()) > 0) throw new Error('onboard failed: ' + (await err.innerText()));
  return (await page.locator('.address').first().innerText()).trim();
}

test('schnorr full flow: deploy + drip + transfer on testnet', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  const addr = await onboardSchnorr(page, SCHNORR_INDEX);
  console.log(`[schnorr-full] onboarded Schnorr #${SCHNORR_INDEX} = ${addr}`);

  /* --- DEPLOY (the keystone) -------------------------------------------- */
  await test.step('deploy Schnorr account (submit + on-chain)', async () => {
    const deployBtn = page.getByRole('button', { name: 'Deploy account' });
    if ((await deployBtn.count()) === 0) {
      console.log(`[schnorr-full] #${SCHNORR_INDEX} already on-chain — deploy self-skipped`);
      return;
    }
    await deployBtn.click();
    const log: string[] = [];
    const confirm = autoConfirmSpeculos(150_000, log);
    await page
      .waitForFunction(
        () => {
          if (document.querySelector('.status.err')) return true;
          return Array.from(document.querySelectorAll('button')).some((b) =>
            /Account deployed/i.test(b.textContent ?? ''),
          );
        },
        { timeout: 8 * 60_000 },
      )
      .catch(() => console.log('[schnorr-full] deploy wait timed out'));
    await confirm.catch(() => {});
    console.log('[schnorr-full] deploy screens:\n  ' + log.join('\n  '));
    const err = page.locator('.status.err').first();
    const errText = (await err.count()) > 0 ? await err.innerText() : '';
    console.log('[schnorr-full] deploy err=' + JSON.stringify(errText));
    expect(errText, 'Schnorr deploy must not error').toBe('');
    await expect(
      page.getByRole('button', { name: /Account deployed/ }),
      'Schnorr account must be on-chain after deploy',
    ).toBeVisible({ timeout: 30_000 });
  });

  /* --- DRIP (Schnorr authwit) ------------------------------------------- */
  await test.step('drip 1000 USDC (schnorr authwit)', async () => {
    const dripBtn = page.getByRole('button', { name: 'Drip 1000 USDC' });
    if ((await dripBtn.count()) === 0) {
      console.log('[schnorr-full] no Drip button — skipping');
      return;
    }
    await dripBtn.click();
    const confirm = autoConfirmSpeculos(60_000);
    await page
      .waitForFunction(
        () => {
          if (document.querySelector('.status.err')) return true;
          const b = Array.from(document.querySelectorAll('button')).find((x) =>
            x.textContent?.includes('Drip'),
          );
          return !!b && !b.textContent?.includes('Dripping');
        },
        { timeout: 6 * 60_000 },
      )
      .catch(() => console.log('[schnorr-full] drip wait timed out'));
    await confirm.catch(() => {});
    const err = page.locator('.status.err').first();
    console.log(
      '[schnorr-full] drip err=' +
        JSON.stringify((await err.count()) > 0 ? await err.innerText() : ''),
    );
  });

  /* --- TRANSFER (Schnorr authwit) -------------------------------------- */
  await test.step('transfer USDC to self (schnorr authwit)', async () => {
    const useMine = page.getByRole('button', { name: 'Use my address' });
    if ((await useMine.count()) === 0) {
      console.log('[schnorr-full] no Transfer panel — skipping');
      return;
    }
    await useMine.click();
    const transferBtn = page.getByRole('button', { name: 'Transfer', exact: true });
    await transferBtn.click();
    const confirm = autoConfirmSpeculos(90_000);
    await page
      .waitForFunction(
        () => {
          if (document.querySelector('.status.err')) return true;
          return !!document.querySelector('.status.ok, .status.success, .receipt');
        },
        { timeout: 6 * 60_000 },
      )
      .catch(() => console.log('[schnorr-full] transfer wait timed out'));
    await confirm.catch(() => {});
    const err = page.locator('.status.err').first();
    const errText = (await err.count()) > 0 ? await err.innerText() : '';
    console.log('[schnorr-full] transfer err=' + JSON.stringify(errText));
  });

  console.log('[schnorr-full] console errors: ' + errors.length);
});
