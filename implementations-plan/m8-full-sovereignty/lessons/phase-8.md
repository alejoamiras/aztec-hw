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

## Deploy ordering bug (found during the first live in-browser deploy)
First real browser deploy failed: *"spy AuthWitnessProvider did not capture an outer_hash."* Root cause (independently traced + **codex-confirmed**, session 019e74e0):
- `DefaultAccountContract.getAccount()` SNAPSHOTS `getAuthWitnessProvider()` into the `DefaultAccountEntrypoint` at build time (`@aztec/accounts account_contract.ts:25-31`); the entrypoint's `this.auth` is fixed then and is NOT re-queried per `createAuthWit` (`@aztec/entrypoints account_entrypoint.ts:123-141`).
- `deployAccount` called `getDeployMethod()` (→ `getAccount()`) BEFORE `setAuthWitnessOverride(spy)`, so the entrypoint kept the default DEVICE provider. The spy (and the frozen pass, reusing the same deploy method) never fired.
- Two symptoms, one cause: in-browser → "did not capture"; headless → `TimeoutError: signal timed out` (the entrypoint's device provider hit an APDU with no buttons; the timeout is an external headless fetch wrapper, NOT Aztec's node client, which in 4.2.1 uses plain `fetch` with no `AbortSignal` — codex).
- **Fix:** install the override THEN build a FRESH deploy method, per pass (spy, then frozen). Validated headless: the deploy now advances to the on-device "Deploy Aztec account" review (`e2e/deploy-review.e2e.ts`, 15.7s). NOT a Phase 7/8 regression — the path is salt/secret-independent (M8-Phase-1 deploy builder).
- Follow-up (codex's preferred, deferred): compute the deploy outer_hash offline (`SponsoredFeePaymentMethod.getExecutionPayload` + `entrypoint.wrapExecutionPayload`/`computeOuterAuthWitHash`) and do ONE frozen request — halves the testnet round-trips, drops the spy. Kept the two-pass spy for now (lower hash-replication risk).
