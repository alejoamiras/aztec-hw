import type { AutoConfirmContext } from './transport.ts';

/**
 * Marker-based NBGL auto-approver — P0 de-brittling (audit-c2-remediation).
 *
 * Replaces the brittle hardcoded-press-count approvers (`makeApprover(rights)`,
 * `approveReview` with a fixed page sequence). Those broke whenever a review
 * gained or lost a page — which W2 (adds a sponsor address+selector pair) and
 * W4 (a whole new GET_AZTEC_ADDRESS review) will both do. This walks the review
 * by READING the screen (`getEvents`) and pressing `right` until the approve
 * prompt text appears, then `both` — page-count-agnostic.
 *
 * Markers are matched against the concatenation of the buffered screen-text
 * events for the current page (we `clearEvents` between presses so each read is
 * the freshly-rendered page, not a stale accumulation).
 */
export interface MarkerApproveOpts {
  /** Regex matching the FINAL approve/sign page's text. */
  readonly approve: RegExp;
  /**
   * Optional regex for a leading GATE page (e.g. the blind-sign "ahead — accept
   * risk" warning) that needs `both` to ENTER the review before scrolling.
   */
  readonly accept?: RegExp;
  /** Safety bound on pages walked before giving up. */
  readonly maxPages?: number;
  /** Settle delay after each press (ms). */
  readonly settleMs?: number;
}

/**
 * Build an `autoConfirm` callback that walks to the approve page by marker.
 * Throws if the approve marker is not seen within `maxPages` — a loud failure
 * beats a hardcoded count silently pressing past a changed screen.
 */
export function approveByMarker(
  opts: MarkerApproveOpts,
): (ctx: AutoConfirmContext) => Promise<void> {
  const { approve, accept, maxPages = 16, settleMs = 250 } = opts;
  return async (ctx: AutoConfirmContext): Promise<void> => {
    await ctx.sleep(400);
    // Discard events buffered by a PRIOR operation. Without this, a second
    // review in the same test reads the previous review's last-page text (e.g.
    // "Reveal this account's privacy root?") still in the buffer, matches the
    // marker on page 0, and presses `both` on the home screen — the new review
    // never advances and the APDU hangs. The current page re-renders on the
    // first `right`, so clearing here loses nothing.
    await ctx.clearEvents();
    for (let page = 0; page < maxPages; page++) {
      // NBGL wraps a long finishYStr across several text events ("Reveal this" /
      // "account's privacy" / "root?"), so the naive join has multiple spaces.
      // Collapse runs of whitespace so markers can be written with single spaces.
      const text = (await ctx.getEvents())
        .map((e) => e.text)
        .join(' ')
        .replace(/\s+/g, ' ');
      if (approve.test(text)) {
        await ctx.press('both');
        return;
      }
      await ctx.clearEvents();
      // A leading gate (blind-sign warning) takes `both` to proceed, not `right`.
      await ctx.press(accept?.test(text) ? 'both' : 'right');
      await ctx.sleep(settleMs);
    }
    throw new Error(`approveByMarker: approve marker ${approve} not seen within ${maxPages} pages`);
  };
}

/**
 * Centralized markers so an on-device wording change updates ONE place instead
 * of every test's press count. Refine the exact regexes against the running
 * emulator's `getEvents()` text (see P0 lessons).
 */
export const APPROVE_MARKERS = {
  /** Blind-sign: leading "Blind signing ahead" gate, final "Sign … outer_hash?". */
  blindSign: {
    approve: /sign[^?]*outer_hash\?|^sign\b|\bsign\?/i,
    accept: /blind signing|accept risk/i,
  },
  /** Deploy account review. Finish-page text ONLY — "Deploy your Aztec account?"
   * (the `nbgl_useCaseReview` finishYStr). Deliberately tight: the intro title is
   * "Deploy Aztec account" (no "your") and the subtitle is "Review and approve",
   * so a looser `\bapprove\b` would fire `both` on the subtitle page. */
  deployReview: { approve: /deploy your aztec account/i },
  /** Master-secret reveal = privacy root. Finish-page text ONLY — "Reveal this
   * account's privacy root?". The intro title "Reveal privacy root" lacks "this
   * account", and the subtitle lacks "reveal this account", so this matches only
   * the final approve page (a bare /privacy root/ would fire on the intro). */
  revealRoot: { approve: /reveal this account/i },
  /** W4 GET_AZTEC_ADDRESS receive-address attestation review. Finish-page text ONLY
   * ("Use this Aztec address?") — the intro title is "Confirm receive address" and the
   * subtitle mentions "Aztec address", so a looser marker would fire on the intro. */
  attestAddress: { approve: /use this aztec address/i },
} as const satisfies Record<string, MarkerApproveOpts>;
