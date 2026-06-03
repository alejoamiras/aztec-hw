# Phase 1 — registry seam (preflight → optional hook) → DONE (green)

Made the host-side `preflightIntent` an **optional injected hook**; the SDK now ships **no contract registry**.

## What moved / changed
- **Relocated to `apps/demo-browser/src/clear-signing/`:** `preflight.ts`, `registry.generated.ts`, `selectors.generated.ts`, `preflight.test.ts` (the relative `./registry.generated` / `./selectors.generated` imports stay valid — co-moved; preflight's `@alejoamiras/aztec-ledger-core` + `@aztec/aztec.js` imports resolve in the demo).
- **STAYS in the SDK:** `deploy_profiles.generated.ts` — it's the *deploy-profile* table (account-class deploy), NOT the preflight contract registry; co-versions with firmware; consumed by the session's deploy + the `./advanced` subpath.
- **SDK keeps only the TYPE:** `export type ClearSignPreflight = (intent: CallIntent) => void` defined in `clear-signing-entrypoint.ts`, re-exported at **root**. `CallIntent` comes from `core`.
- **Threading (end-to-end optional):** `ClearSigningEntrypointOptions.preflight?` → call site `this.options.preflight?.(intent)` (was unconditional `preflightIntent(intent)`); `LedgerProviderOptions.preflight?` → `createClearSigningEntrypoint` passes it through; `Ledger{EcdsaK,Schnorr}AccountContractOptions extends LedgerProviderOptions`, so the demo injects it via the contract ctor.
- **Demo session** passes `preflight: preflightIntent` (demo-local) to both account contracts.

## Why this is safe (re-confirmed)
`grep` proved `preflight.ts` is the **SOLE** SDK consumer of the registry (`CS_REGISTRY`/`CS_VERBS`/lookups) — the audit claim holds. The device re-validates every gate the preflight checks (REGISTRY_MISS / DECODER_MISS / DESYNC / VISIBILITY / 4-arg delegated-spend / DRIP token-kind) in `append_call.c`, and the entrypoint already **discards** preflight's return — its only effect was a fast typed throw. So omitting the hook never lets a bad call through; it only drops host-side UX.

## ⚠️ Caveat for P2
The codegen `scripts/gen-clear-signing-v0.ts` still WRITES `registry.generated.ts` + `selectors.generated.ts` to the OLD SDK path (`packages/aztec-ledger/src/clear_signing_v0/`). Re-running it now would regenerate them into the (now-removed) SDK location. **P2 must rewire the codegen** to emit registry+selectors → the demo's `clear-signing/`, and deploy_profiles → the SDK, with explicit `--out` flags.

## Validation (green)
`lint:all` 0 · `bun test packages/` 122 pass / 0 fail (preflight tests left for the demo) · `bun test apps/demo-browser` 21 pass / 0 fail (they run here now) · SDK+demo `tsc` clean · demo `vite build` ✓ · **P1 boundary: `CS_REGISTRY`/`registry.generated`/`selectors.generated`/`preflightIntent`/`PreflightError` ∅ in `packages/aztec-ledger/src`** (only the `ClearSignPreflight` TYPE remains, at root) · runtime pxe/wallets/noir boundary still ∅.

## Next — P2 (codegen relocation)
Move `gen-clear-signing-v0.ts` + `manifest.json` to root `tools/clear-signing-codegen/` with `--manifest/--out-c/--out-ts` flags; emit firmware C tables + the demo's TS registry; SDK depends on none of it (drops the `@aztec/noir-contracts.js` devDep).
