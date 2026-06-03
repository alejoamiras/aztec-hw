# Phase 0 step b — relocate the demo session glue → DONE (green)

Moved the PoC glue OUT of the SDK into `apps/demo-browser/src/`:
- `session-embedded-wallet.ts` (self-contained; carried `@aztec/pxe` + `@aztec/wallets` out)
- `aztec-ledger-session.ts` (repointed its 8 SDK-internal imports → `@alejoamiras/aztec-ledger-sdk`; kept `./session-embedded-wallet.ts` relative)
- `aztec-ledger-session.test.ts` (relative session import stays valid — co-moved)
- `aztec-ledger-session.integration.test.ts` (skipped scaffold; only `bun:test`)

Barrel (`index.ts`) surgery, still broad (P0c trims): dropped the `AztecLedgerSession`/`SessionEmbeddedWallet` exports; **added the 4 symbol-groups the moved session now pulls from the SDK** — `LedgerSchnorrAccountContract`, `CAPS`, `assertDeviceAttestedAddress`(+`DeviceAttestationCheck`), `csDeployProfileLookup`(+`CsDeployProfileId`).

## Deliberate plan deviations (logged)
- **`deploy-profile-selection.test.ts` STAYS in the SDK.** The plan's move-list named it, but it imports *only* `csDeployProfileLookup` from the SDK-internal generated table `deploy_profiles.generated.ts` (which co-versions with firmware and is NOT in the move-list) — zero session coupling. Moving it would force exporting an internal purely to relocate a test. Tests live with the code they test → it stays.

## Surprises
- **A multi-line `import` my single-line `grep '^import.*from'` missed**: the session also imported `./clear_signing_v0/deploy_profiles.generated.ts` (the `from` was on the closing `}` line). Always grep `from '\./` (matches multi-line too), not `^import`.
- **`@aztec/entrypoints` was a net-new demo dep** opus's audit missed (it listed only pxe+wallets). The moved session imports `@aztec/entrypoints/{account,default}`. tsc + the bun test both failed with `Cannot find module` until added. Everything else the session imports (`aztec.js`, `foundation`, `stdlib`, `noir-contracts.js`, `pxe`, `wallets`) the demo already had.
- **`@aztec/noir-contracts.js` is a SDK `devDependency`, not a runtime dep** — used only by the codegen script (`scripts/gen-clear-signing-v0.ts`) + referenced in `manifest.json` comments. So it is NOT a P0b runtime-boundary leak; it exits the SDK with the codegen in **P2** (relocate to root `tools/`). The DONE `git grep … = ∅` is the *post-P2* state.

## Validation (green)
`bun run lint:all` 0 · `bun test packages/` 132 pass / 0 fail · `bun test apps/demo-browser` 10 pass / 1 skip / 0 fail · demo `tsc` clean · **runtime boundary**: SDK `dependencies` + `src/**` are ∅ of `pxe|wallets|noir-contracts`.

## Next — P0c (cut the barrel LAST)
Trim the root barrel to the ~12 safe symbols; demote transports → `./webhid`/`./node-hid`/`./speculos`, raw `LedgerProvider`/reveal/onboarding → `./advanced`, `./unsafe` stays. Repoint the demo session + panels to the final root/subpath API. Mirror `exports` map.
