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

## Status
- [x] Seam research (this doc)
- [ ] Spike harness (register `BaseAccount(myEntrypoint)` + real `sendTx` transfer)
- [ ] Transfer proven on testnet (Speculos) + nonce confirmed
- [ ] Deploy `feeEntrypointOptions` → `wrapExecutionPayload` proven (or gap recorded)
- [ ] safe-v20 (P0 gate) signed + pushed
