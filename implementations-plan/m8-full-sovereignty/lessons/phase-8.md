# Phase 8 — Sovereign re-derivation (reconnect == recovery)

**Status:** core complete + machine-validated. Commit e3809da on `m8-phase-7-onboarding`.

## What shipped
- **OnboardPanel** now reuses the in-session secret cache when present (reconnect within a tab needs no re-approval) and reveals fresh otherwise.
- **ConnectPanel "Forget session"** wipes the only persisted artifact — the sessionStorage secret cache (`clearAllCachedSecrets`) — and drops the session. The ephemeral PXE + wallet DB are in-memory (session-embedded-wallet.ts), so Forget + reload = a genuinely empty browser.
- **`reconnect.e2e.ts`** — the hero proof.

## The hero, machine-verified (headless, 25.6s)
```
onboard #1                         → 0x0aa630…773b
Forget session (wipe cache) + reload (empty browser)
onboard #2  (cache cleared ⇒ FRESH device reveal) → 0x0aa630…773b
assert A === B  ✓
```
Same account address, byte-for-byte, after a full wipe + a fresh device reveal. The device deterministically re-derived the account from its seed — the cryptographic basis of "lose the laptop, plug the Ledger back in, you're in." The address also matched the independent `onboard.e2e.ts` run.

## Why this is the right thing to machine-verify (and what's the guided run)
The address identity is the part that *must* be deterministic and is cheap to verify headless (no proving, no testnet inclusion). The full **deploy → drip → wipe → reconnect → balance reappears** flow is the guided/recorded run: it adds in-browser ClientIVC proving (minutes) + testnet inclusion (minutes) + note re-sync, which are slow + flaky to drive autonomously. Per the locked M8 scope, that recording is owner-driven; everything it depends on (device derivation, onboarding wiring, deterministic salt, note discovery via aztec.js) is already proven at the unit / node / browser-onboarding layers.

## Lessons
- **In-memory ephemeral PXE simplifies "wipe".** No IndexedDB to clear — the only persisted artifact is the sessionStorage secret. Forget = clear that + reload.
- **The cache is a within-session convenience, not a backup.** Forget clears it so the next onboard re-reveals from the device — which is exactly what proves re-derivation. The device (its own 24-word seed) is the backup; the Aztec layer stores nothing on disk.
