# Phase 0 step c — cut the root barrel + subpaths → DONE (green). P0 COMPLETE.

Cut the broad barrel down to the **safe-by-default** root surface and demoted everything else to subpaths.

## The split
- **Root (`.`)** — ~14 safe symbols, mostly types: `LedgerEcdsaKAccountContract`/`LedgerSchnorrAccountContract` (+ options), `assertDeviceAttestedAddress`(+`DeviceAttestationCheck`), `defaultAztecPath`, `CAPS`/`CURVE_ID`/`CurveId` (version-caps), `DeployContext`, `VersionInfo`, `AutoConfirmContext`/`LedgerTransport` types. **No** concrete transport, **no** raw signer, **no** reveal.
- **`./advanced`** (new) — the expert/unguarded surface, explicitly OUTSIDE the fail-closed guarantees: raw `LedgerProvider`, reveal/onboarding, secret-cache controls, the auth-witness provider, the deploy-profile lookup, low-level APDU/path constants.
- **`./webhid`** + **`./speculos`** (new) — concrete transports. **`./unsafe`** unchanged (raw signer).
- `exports` map mirrors all 5 (`.`/`./advanced`/`./speculos`/`./unsafe`/`./webhid`). `./node-hid` lands in P3.

## Repoints (4 demo files)
`state.ts` `LedgerTransport` stayed root (no change). Session → `LedgerEcdsaKAuthWitnessProvider`+deploy-profile from `./advanced`. `ConnectPanel` split 3 ways (`./advanced` raw provider+cache, `./speculos`, `./webhid`). `OnboardPanel` reveal → `./advanced` (path stayed root).

## Test update (expected, not a regression)
`w3-api-shape.test.ts` encoded the old all-at-root shape → updated to the P0c split AND **strengthened**: AHW-097 (raw signer) + AHW-103 (raw cache reread) primitives are now asserted public *nowhere* (not root, not `./advanced`); reveal/cache controls are `./advanced`-only; root is clean. Net +2 tests.

## Lessons
- **A doc comment naming the demoted symbols trips a naive `grep` boundary check.** My "→ ./advanced" comment matched the forbidden-symbol grep. Scope the proof to `^export` statements, not the whole file.
- **tsc passing on subpath imports is necessary but not sufficient** — also run the real bundler. The demo `vite build` is the proof that `exports`-map subpaths resolve under esbuild/rollup, not just `moduleResolution: bundler` in tsc. Both green here.

## Validation (green)
`lint:all` 0 · `bun test packages/` 133 pass / 0 fail · `bun test apps/demo-browser` 10 pass / 0 fail · SDK `tsc` no new errors · demo `tsc` clean · **demo `vite build` ✓ (subpaths resolve in the bundler)** · root barrel has no transport/raw-signer/reveal · runtime deps + src ∅ of pxe/wallets/noir.

## Next — P1 (registry seam)
Make `preflightIntent` an optional injected `ClearSignPreflight` hook; RELOCATE `preflight.ts` + `registry.generated.ts` + `selectors.generated.ts` + `PreflightError`/`PreflightDecodedCall` to the demo; SDK keeps only the hook TYPE. Device stays authoritative (it re-validates every gate).
