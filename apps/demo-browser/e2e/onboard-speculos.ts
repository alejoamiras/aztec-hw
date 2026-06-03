/**
 * Shared Speculos onboarding-approval helpers for the demo e2e suite.
 *
 * Every onboarding e2e drives the SAME two on-device reviews during the "Derive
 * viewing keys" step, so the walks live here once instead of being copy-pasted:
 *   1. the reveal (GET_AZTEC_MASTER_SECRET) review, and
 *   2. W4 (AHW-098) — the receive-address attestation that connect() now runs by
 *      default ("Confirm receive address" → … → "Use this Aztec address?").
 *
 * All helpers take the Speculos REST base URL so each test can point at its own
 * emulator instance. Button presses go through the Speculos `/button/<b>` API.
 */

/** Press a Nano S+ button via the Speculos REST API (best-effort; swallows fetch errors). */
export async function pressSpeculos(url: string, button: 'left' | 'right' | 'both'): Promise<void> {
  await fetch(`${url}/button/${button}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'press-and-release' }),
  }).catch(() => {});
}

/** Current Speculos screen text (joined events), or a sentinel if unreachable. */
export async function speculosScreen(url: string): Promise<string> {
  try {
    const res = await fetch(`${url}/events?currentscreenonly=true`);
    const json = (await res.json()) as { events: { text: string }[] };
    return json.events.map((e) => e.text).join(' | ');
  } catch {
    return '<unreachable>';
  }
}

/**
 * Approve the reveal (privacy-root) review. It is 6 screens (intro, subtitle ×2,
 * Account, Confirm, finish) → 5 rights to reach "Reveal this account's privacy
 * root?" then Both. A FIXED count, not a marker walk: an event-polling approver
 * races this particular review's renderer into an accidental Reject (0x6985).
 */
export async function revealApprove(url: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 1500)); // let the reveal review render
  for (let i = 0; i < 5; i++) {
    await pressSpeculos(url, 'right');
    await new Promise((r) => setTimeout(r, 450));
  }
  await pressSpeculos(url, 'both');
}

/**
 * Walk the W4 receive-address attestation review (the 2nd review connect() runs
 * after the reveal + the slow browser PXE/session build). Latches once a
 * distinctive screen is seen — NBGL wraps the title across events
 * ("Confirm receive  | address"), so we match the loose "Confirm receive" (or the
 * "Scheme" pair) and then advance through EVERY screen (the "Address 0x…" / pair
 * screens carry no unique keyword) to "Use this Aztec address?" → Both.
 *
 * Deliberately never presses on the home screen (blind right-presses there navigate
 * the app menu and can land on Quit) — it waits until the review renders. Returns
 * once approved, or when the deadline lapses so it never wedges the test.
 */
export async function confirmAddressReview(
  url: string,
  timeoutMs = 200_000,
  screenLog?: string[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let prev = '';
  let inReview = false;
  while (Date.now() < deadline) {
    const screen = await speculosScreen(url);
    if (screen !== prev) {
      screenLog?.push(screen);
      prev = screen;
    }
    if (/Use this Aztec/i.test(screen)) {
      await pressSpeculos(url, 'both'); // finish page → approve, done
      return;
    }
    if (/Confirm receive|Scheme/i.test(screen)) {
      inReview = true;
    }
    if (inReview) {
      await pressSpeculos(url, 'right'); // walk intro/subtitle/Address/Account/Scheme → finish
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    await new Promise((r) => setTimeout(r, 500)); // not in the review yet → wait (never press on home)
  }
}
