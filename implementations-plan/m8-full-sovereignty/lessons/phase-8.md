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

## FULL deploy validated end-to-end on testnet ✅
After the ordering fix, the complete sovereign deploy ran green headless (1.6 min): onboard → BEGIN (silent) → **FINALIZE deploy review approved on-device** → "Transaction signed" → ClientIVC proving → submit → **included on testnet**. Button → "✓ Account deployed", no errors. Real tx: `0x2b910fb4b5e85289da0a3b2dbd9c6cc8be3b590169e2044b00adb430c21a3dbe` (aztecscan). Device-derived account `0x0aa630…773b` deployed by the device's own clear-signed approval.
- **FINALIZE approver = BLIND single sequence, not continuous.** The deploy review is shown ONCE by FINALIZE_DEPLOY_AND_SIGN (`deploy_review_ui.c`); BEGIN has no UI. Drive it with `5×right + both` ONCE (= `provider.m8.test.ts makeApprover(5)`), then go quiet. A continuous screen-walking approver races the NBGL renderer → desync → the device returns a 3-byte response instead of the 64-byte sig (`FINALIZE_DEPLOY_AND_SIGN: expected 64 bytes, got 3`). This is the same race the phase-6 lessons flagged for the node tests.
- **Deterministic salt ⇒ the full-deploy e2e is ONE-SHOT.** The address is fixed (`0x0aa630`), so once deployed a re-run hits "already deployed". The full-deploy script was therefore a one-time validation (not committed as a repeatable test). The repeatable guard is `deploy-review.e2e.ts` (checks the spy captures + the review appears, which happens before submit — independent of on-chain deploy state). A repeatable full-deploy test would need an explicit per-run salt (the UI uses the deterministic default).
