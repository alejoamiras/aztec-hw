# Phase 0 — SPIKE (hard gate): seam research + isolated-spike strategy

## Goal (from the active /goal)
Prove, on-chain, BEFORE deleting anything:
- **(a) transfer** through the REAL `EmbeddedWallet.sendTx` clear-signs via
  `LedgerClearSigningEntrypoint` with IN-BAND device signing; lands on testnet;
  `nonce_signed == nonce_on_chain`.
- **(b) self-paid `NO_FROM` deploy** carries `DeployContext` to the device via
  `fee.feeEntrypointOptions` → `wrapExecutionPayload(options)`.

## Seam map (researched directly — `git grep` + reads, no assumptions)

### Current TRANSFER path = a BYPASS (this is what P0 replaces)
- `AztecLedgerSession.submitClearSignedIntent(exec)` (`aztec-ledger-session.ts:759`)
  builds a `CallIntent`, calls `ledgerProvider.createAuthWitFromIntent(intent, txNonce)`
  to clear-sign on the device, assembles the tx, and calls **`nodeClient.sendTx(tx)`
  directly** — it **bypasses `BaseWallet.sendTx`** (comment at `:17`,
  `session-embedded-wallet.ts:105`).
- WHY the bypass exists: the framework path `getAccount()` → `DefaultAccountEntrypoint`
  → `auth.createAuthWit(messageHash)` only has the **hash**, so our hash-only
  `createAuthWit` (`auth-witness-provider.ts:88`) can only **blind**-sign
  (`signAndWrap(outerHash)`). To clear-sign, they hand-drive `createAuthWitFromIntent`
  (`:104`, which has the full intent → builds the manifest → streams BEGIN/APPEND/
  FINALIZE → device recomputes + signs) and skip `sendTx`.
- **`LedgerClearSigningEntrypoint` fixes this at the root**: the real `BaseWallet.sendTx`
  → `createTxExecutionRequest(exec, …)` receives the FULL `ExecutionPayload`, so it can
  clear-sign IN-BAND (consuming the framework's `txNonce`), then delegate to the stock
  `DefaultAccountEntrypoint` for canonical assembly. No bypass needed.

### Current DEPLOY path = spy/freeze two-pass (also via `getAccount()`)
- `deployAccount` (`aztec-ledger-session.ts:392-508`): picks `txNonce = Fr.random()`,
  builds `deployFee` with `feeEntrypointOptions: { txNonce, …EXTERNAL, cancellable:false }`,
  Pass-1 installs a **spy** `AuthWitnessProvider` via `accountContract.setAuthWitnessOverride`
  to capture the framework outer_hash, signs on-device via `createAuthWitForDeploy(ctx, hash)`,
  Pass-2 installs a `FrozenAuthWitnessProvider(witness, hash)` and re-runs `request()`.
- CRITICAL (codex-confirmed, `:404-412`): `getDeployMethod()` → **`getAccount()` SNAPSHOTS
  `getAuthWitnessProvider()` into the entrypoint at build time** — so the override must be
  installed BEFORE `getDeployMethod()`, fresh method per pass.
- Uses `deployer: AztecAddress.ZERO` (universal deploy) — so it already exercises the
  framework deploy path; `feeEntrypointOptions.txNonce` is ALREADY threaded.

### Consequence for P0 wiring
Overriding `LedgerEcdsaKAccountContract.getAccount()` to return my entrypoint would
change BOTH transfer AND deploy (deploy's `getDeployMethod()` snapshots whatever
`getAccount()` returns). So a standalone `getAccount()` override is **NOT** a safe,
isolated checkpoint — it silently re-routes the proven deploy onto an unproven path.

## SPIKE STRATEGY (isolated, delete-nothing, prove-first)
Do **not** touch `account-contract.ts`/`getAccount()` for the spike. Instead:
1. Build a `BaseAccount(new LedgerClearSigningEntrypoint(addr, ledgerProvider, opts),
   authWitnessProvider, completeAddress)` by hand.
2. `wallet.registerExternalAccount(addr, account, …)` so `getAccountFromAddress`
   resolves to it → the **real** `wallet.sendTx(...)` now routes a transfer through
   my entrypoint, while the existing deploy keeps using its own (untouched) path.
3. Drive a transfer via the real `sendTx`; assert it lands on testnet; capture the
   `txNonce` the entrypoint signed and confirm successful inclusion (a nonce mismatch
   between authwit and request would fail the proof / be rejected → inclusion IS the
   `nonce_signed == nonce_request` proof; log the nonce for explicit confirmation).
4. Deploy (b): a focused run that switches deploy to a self-paid `NO_FROM` path with
   `fee.feeEntrypointOptions` carrying `DeployContext`, reaching `wrapExecutionPayload`.
   If that pass-through can't carry what the device needs → STOP, keep the custom deploy
   path, record the genuine gap (per the goal).

This keeps P0 a true de-risk: prove the entrypoint through the real `sendTx` in
isolation; only P1 makes the permanent `getAccount()` wiring + deletes the bypass +
spy/freeze + Frozen provider.

## Artifacts so far
- `clear-signing-entrypoint.ts` — built, typechecks clean, committed `44d2707` (signed).
  Composes `DefaultAccountEntrypoint`; `#consume` enforces stream-A-claim-B; asserts
  `buildL4Manifest.claimedOuterHash == canonical computeOuterAuthWitHash` (parity).

## P0 TRANSFER GATE — PROVEN ✅ (2026-06-01)
Ran `SCHEME=ecdsa SEAM=entrypoint TRANSFER_MODE=pub-pub SCHNORR_INDEX=0` (full-flow e2e,
Speculos 5001 + testnet). Result: **1 passed (3.3m), 0 console errors**.
- app loaded clean → the new `LedgerClearSigningEntrypoint` + `@aztec/entrypoints/account`
  + `@aztec/entrypoints/encoding` subpath imports BUNDLE in the browser (Vite) — big de-risk.
- onboarded ECDSA #0 `0x0aa630…773b`; deploy self-skipped (already on-chain); drip OK (legacy).
- **transfer via REAL `EmbeddedWallet.sendTx`** (`transferViaRealSendTx` → `overrideAccount`
  → `BaseAccount(LedgerClearSigningEntrypoint)`): `err=""`, tx
  `0x2b146ce0027890d7f3a5563dc910d9b87d32fc19058f4a5b13b8ef2f140a0fd8`
  (testnet.aztecscan.xyz/tx-effects/0x2b146ce0…).

**Why this proves `nonce_signed == nonce_on_chain`:** `BaseWallet.sendTx` picks `txNonce`
and passes it into `createTxExecutionRequest(exec, …, { txNonce })`. Our entrypoint clear-signs
the device using *that same* `options.txNonce` (one variable → both the signed `outer_hash`
AND the inner DefaultAccountEntrypoint's request). `sendTx` with default wait returns a
**mined** receipt, so `transferViaRealSendTx` resolving without throwing = the proof verified
the device authwit against the request's nonce AND the tx was included. A nonce mismatch would
fail proving / be rejected. The `#consume` stream-A-claim-B guard did NOT reject → the inner
recomputed hash equalled the device-signed hash. Device guarantees intact (firmware unchanged;
device independently recomputes outer_hash + B3 consumer binding still in force).

NOT gold-plated: no explicit nonce-readback added — inclusion is the cryptographic proof.

## Status
- [x] Seam research (this doc)
- [x] Spike harness (register `BaseAccount(myEntrypoint)` + real `sendTx` transfer)
- [x] **Transfer PROVEN on testnet (Speculos)** — tx `0x2b146ce0…`, nonce by construction
- [ ] Deploy `feeEntrypointOptions` → `wrapExecutionPayload` proven (or gap recorded) — NEXT
- [x] safe-v20 (P0 transfer gate) — tagging + pushing now
