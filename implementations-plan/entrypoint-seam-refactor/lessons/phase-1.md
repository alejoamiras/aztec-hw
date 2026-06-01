# Phase 1 — migrate TX+deploy onto the entrypoint, delete workarounds

## Done so far
- **P1.1 — entrypoint is the proven DEFAULT (commit 4ba86f3).** Dropped the `?seam` gating:
  `transferUsdc` + `dripUsdc` → `transferViaRealSendTx` (real `EmbeddedWallet.sendTx` via
  `LedgerClearSigningEntrypoint`); AccountPanel deploy → `deployAccountViaEntrypoint`.
  **Validated on testnet (no ?seam, ECDSA #2):** `drip err=""` (drip via entrypoint — FIRST
  proof) + `transfer err=""` (tx `0x285ad017…`), 1 passed / 0 console errors.
- **P1.2a — deleted the session legacy (commit a14bc4d, −352 LOC net).** Removed
  `submitClearSignedIntent` + `runRecipe` (the sendTx bypass) + the legacy spy/freeze
  `deployAccount` + the `[transferUsdc]` debug log + now-unused imports. Test adapted
  (2-call-guard test dropped; mutex tests → `transferViaRealSendTx`), 3/3 pass. tsc+biome clean.

## ⚠ REGRESSION to fix FIRST (introduced by P1.1+P1.2a)
`deployAccountViaEntrypoint` is **ECDSA-only-guarded** (`instanceof LedgerEcdsaKAccountContract`),
and the legacy `deployAccount` (which handled Schnorr deploy) is deleted. So **Schnorr deploy now
throws.** ECDSA default flow is validated+working; Schnorr-deploy is a LATENT regression (only hit
on Schnorr-toggle + fresh deploy). Must mirror the seam to Schnorr before P1 closes.

## Remaining P1 — PRECISE design (execute next; verify tsc+biome+test each step)

### P1.2b — shared base + Schnorr mirror + delete spy/freeze machinery (one commit)
Both `LedgerEcdsaKAccountContract` + `LedgerSchnorrAccountContract` currently duplicate
`defaultProvider` + `overrideProvider`/`setAuthWitnessOverride` (spy/freeze — now ORPHANED, the
only caller `deployAccount` is deleted) + `getAuthWitnessProvider`/`getProvider`; only ECDSA has the
entrypoint override. Fix by a SHARED base (dedups + mirrors Schnorr + drops spy/freeze):
```ts
// ledger-account-contract-base.ts (new)
export abstract class LedgerAccountContractBase extends DefaultAccountContract {
  #entrypointOverride: EntrypointInterface | null = null;
  constructor(protected readonly defaultProvider: LedgerEcdsaKAuthWitnessProvider) { super(); }
  setEntrypointOverride(e: EntrypointInterface | null): void { this.#entrypointOverride = e; }
  override getAccount(a: CompleteAddress): Account {
    return this.#entrypointOverride
      ? new BaseAccount(this.#entrypointOverride, this.getAuthWitnessProvider(a), a)
      : super.getAccount(a);                       // (native-getAccount cleanup is a later option)
  }
  override getAuthWitnessProvider(_a: CompleteAddress): AuthWitnessProvider { return this.defaultProvider; }
  getProvider(): LedgerEcdsaKAuthWitnessProvider { return this.defaultProvider; }
}
```
ECDSA/Schnorr subclasses keep ONLY their ctor (`super(new LedgerEcdsaKAuthWitnessProvider(transport, …))`)
+ `getContractArtifact` + `getInitializationFunctionAndArgs`. This REMOVES `setAuthWitnessOverride`/
`overrideProvider` from both (spy/freeze orphan gone) AND gives Schnorr `setEntrypointOverride`.
Then in `deployAccountViaEntrypoint`: **remove the `instanceof LedgerEcdsaKAccountContract` guard**
(the union now has `setEntrypointOverride` via the base) → Schnorr deploy works. The provider's
`createClearSigningEntrypoint` is already scheme-generic (curveId=GRUMPKIN for Schnorr). ECDSA
behavior UNCHANGED (getAccount logic identical) — only Schnorr is newly enabled.

### P1.2c — delete the rest of the workarounds
- `auth-witness-provider.ts`: delete `createAuthWitFromIntent` (lines ~96-143, the TX-driving) +
  `createAuthWitForDeploy` (~160-201, the spy/freeze deploy sign). KEEP `createAuthWit` + `signAndWrap`
  + `createClearSigningEntrypoint` + `getPublicKeyXY`. biome will drop now-unused imports
  (`preflightIntent`, `buildL4Manifest`, `CallIntent`, `DeployContext`).
- DELETE `frozen-auth-witness-provider.ts` + `frozen-auth-witness-provider.test.ts`; remove the
  `FrozenAuthWitnessProvider` export from `index.ts`; scrub stale comments (session header,
  account-contract, auth-witness-provider).
- Remove `SubmitOptions.viaEntrypoint` (unused). Drop the e2e `SEAM` env (the default IS the entrypoint).
- **Re-validate Schnorr deploy+drip+transfer on testnet+Speculos** (fresh Schnorr index, no ?seam).

### P1.3 — reuse @aztec/entrypoints/encoding (drop the l4-manifest REPLICA + 2770bcb pin)
`l4-manifest.ts` keeps the device WIRE bytes (the BEGIN/APPEND stream) but its expected outer_hash
must derive from the CANONICAL `EncodedAppEntrypointCalls` (already imported in the entrypoint).
Drop the host-side payload replication + the `2770bcb` commit-pin in the header. Add a host-vs-device
hash PARITY test against installed 4.2.1 (the entrypoint already asserts
`manifest.claimedOuterHash == computeOuterAuthWitHash(…)` at runtime — promote to a unit test).

### P1.4 — device-guarantee tests
- A test proving **stream-A-claim-B is rejected**: `#consume` throws when the inner-recomputed hash
  != the device-signed hash (drive the entrypoint with a mock device that signs hash X, force the
  inner to compute Y). Preserve: independent outer_hash recompute reject-on-mismatch, B3
  consumer/address binding, M8-P6 sovereignty (already covered by existing device tests — confirm green).
- Firmware UNCHANGED. Never claim fee-mode/cancellability/capsules are clear-signed (already enforced
  in the deploy branch: EXTERNAL + cancellable=false asserted).

### P1.5 — codex post-impl review of the P1 diff (adversarial) → fold → safe-v22 (signed, pushed)

## Status
- [x] P1.1 default flip + validated (4ba86f3)
- [x] P1.2a session legacy deleted (a14bc4d)
- [ ] P1.2b shared base + Schnorr mirror + drop spy/freeze (fixes the regression)
- [ ] P1.2c delete provider intent/deploy methods + Frozen + viaEntrypoint; re-validate Schnorr
- [ ] P1.3 encoder reuse + parity test
- [ ] P1.4 stream-A-claim-B + device-guarantee tests
- [ ] P1.5 codex review → safe-v22
