# Phase 5 + 6 — Transfer modes + CSS polish (demo-prep bundle)

**Status:** completed
**Why bundled:** user wanted these landed before P4 so the demo could be recorded with a known-working state — P4 is the riskiest change (replaces the deploy path).

## P5 — Transfer modes

The 4-mode dropdown + `callWrapper` switch were already in `TransferPanel.tsx` from prior arcs (M6.9-era). Functionally, P5 only needed verification — the M6.12 selector fix made all 4 modes valid. Two demo-flow improvements:

1. **`MODE_HINTS`** — per-mode caption beneath the dropdown explaining what each transfer does. Helps the demo audience understand the semantic differences:
   - pub→pub: "Visible on-chain. Cheapest gas, no proving."
   - priv→pub: "Sender stays anonymous."
   - pub→priv: "Debit your public balance → mint a private note for the recipient."
   - priv→priv: "Fully shielded; only sender + recipient know."

2. **"Use my address" ghost button** next to the recipient input. Click-fill the user's own address. Demo-critical because the user typically has no second testnet account handy. Self-transfer exercises the same code paths and gives a verifiable round-trip.

## P6 — CSS polish

Net diff: ~120 inserts / 42 deletes on style.css. Slightly over the 80-line target but well within scope — most of the inserts are new design tokens that future polish will use.

Applied per plan §5:

- **Token expansion** (`:root`): added `--bg-elev-1`, `--bg-elev-2`, `--fg-strong`, `--fg-muted`, `--fg-subtle`, `--accent-soft`. Kept legacy aliases (`--card`, `--muted`) so existing rules don't break. Anti-phishing reminder block added at the top.
- **Body**: font 14px → 15px, line-height 1.5 → 1.55. Reads less crammed.
- **h1**: 1.4rem → 1.65rem, weight 600, slightly tighter letter-spacing. Reads as a hero.
- **h2**: 1rem → 0.78rem, weight 600 (was 500). Reads as a section marker, not body.
- **Mono stack**: dropped `'SF Mono'` (Apple-only; on Linux/Windows it falls back wrong). Use `Menlo` as the fallback.
- **Status bar**: padding 0.85→1rem vertical, 1→1.25rem horizontal, border-radius 8→10px, box-shadow added so it visually lifts above panels. Badge padding +5px horizontal (was claustrophobic).
- **Phase timeline connector bug fix**: previous `left: 60%; right: -40%` overshot the last marker on narrow viewports. Anchored offsets to the marker radius (0.85rem) — connector always meets the next center.
- **Phase pulse**: animation `infinite` → `3` cycles. Codex audit + opus both flagged: infinite pulses on signing screens are a phishing pattern. Three cycles is enough to draw the eye, then settle.
- **Panels**: border-radius 8→10px; `.disabled` opacity 0.45→0.55 (was unreadable); `transition: opacity 120ms`.
- **Inputs**: bg → `--bg-elev-2`, border-radius 4→6px, padding bump, transition on border-color.
- **Buttons**: border-radius 4→6px; box-shadow + `:active { translateY(1px) }` press feedback; disabled `opacity: 0.6` for "disabled because prerequisite" hint; new `.button-ghost` variant for the "Use my address" quick-fill in TransferPanel.
- **Address pill**: `word-break: break-all` → `overflow-wrap: anywhere`. Pill styling (bg + border + radius + padding). Explicit comment: NO `✓ Verified` checkmarks allowed — only the device screen is authoritative.
- **`aria-current="step"`** on the active phase `<li>` for screen-reader announcement.

## Verification

- `bun run lint` clean.
- `bun test` 110 pass / 0 fail / 1 skip.
- No new visual regressions in StatusBar / AccountPanel / TransferPanel (manual inspection only — no Playwright DOM stability test yet; P4 demo recording is the real smoke test).

## Notes for demo recording

- Speculos is rebuilt with the M7 P3 elf (clear-sign deploy scaffold) — but deploy itself STILL goes through the framework blind-sign path until P4 wires the host builder. So the demo will show the new visual polish + accurate phase timeline + the OLD deploy review screen on device. Acceptable for a checkpoint recording.
- The "Use my address" button is demo-critical: pasting into the transfer To field can take 5+ seconds on slow recordings; one click is faster.
- Address truncation is still 4+4 in the panel UI (no change here). The 8+6 lock applies to the device deploy review screen which lands in P4 + the new device elf. Plan §3.5 said apply 8+6 to host pills "for consistency" but that's host-side cosmetic; we kept 4+4 for now since the panel UI was using `short_hex_field`-style 4+4 already and changing it ripples through other places.
