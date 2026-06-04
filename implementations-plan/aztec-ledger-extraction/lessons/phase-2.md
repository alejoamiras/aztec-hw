# Phase 2 — codegen relocation → DONE (green)

Moved the clear-signing codegen OUT of the SDK so the SDK depends on none of it.

## What changed
- **New workspace `tools/clear-signing-codegen/`** (added `tools/*` to root `workspaces` + the `sort-package-json` globs). `git mv` of `gen-clear-signing-v0.ts` + `manifest.json` into it; a `package.json` that deps the artifacts (`@aztec/accounts`, `@aztec/noir-contracts.js`, `@aztec/stdlib`, `@defi-wonderland/aztec-standards`).
- **SDK drops both codegen devDeps** (`@aztec/noir-contracts.js`, `@defi-wonderland/aztec-standards`) → SDK `devDependencies` is now empty. Removed the 2 stale `gen:clear-signing-v0*` SDK scripts.
- **Rewired the codegen:** `REPO_ROOT` = `../..`; manifest = `__dirname/manifest.json`; artifacts = `__dirname/node_modules/...` (tools-local). **3-way output split** with flags: `--out-c` (firmware C → `ledger-app/...`), `--out-ts` (demo preflight registry → `apps/demo-browser/src/clear-signing`), `--out-ts-sdk` (SDK deploy table → `packages/aztec-ledger/src/clear_signing_v0`), `--manifest`.
- Fixed stale source-of-truth comments + the manifest `_comment` authority doc to the new topology.

## Lessons
- **bun does NOT hoist workspace deps to root `node_modules`** here — each package's deps link into ITS OWN `node_modules` (real files in `node_modules/.bun/`). So the codegen must resolve artifacts from `__dirname/node_modules/...` (tools-local), NOT `REPO_ROOT/node_modules/...`. My first rewire used REPO_ROOT and the artifact read would have failed — caught by locating the file with `find` before trusting the path.
- **The committed firmware C headers carried a STALE `packages/adapter-ledger/...` source path** — generated pre-P0-rename and never regenerated (the rename only sed'd source, not generated artifacts). The relocated codegen's `--check` surfaced it (2 `.gen.h` drifts); regenerating fixed it. **`--check` is the real drift tripwire** — it caught a months-stale comment the rename missed.
- **The TS output is a 2-way split** (demo registry/selectors + SDK deploy_profiles) — a single `--out-ts` is insufficient; needed `--out-ts` + `--out-ts-sdk`.

## Validation (green)
codegen `--check` "in sync" (from `tools/`, after the SDK devDep drop) · `lint:all` 0 · `bun test packages/` 122 pass / 0 fail · demo `tsc` clean · demo `vite build` ✓ · **SDK is codegen-dep-free** — `@aztec/noir-contracts.js`/`aztec-standards` appear only in 2 SDK comments (`l4-manifest.ts:87`, `apdu.ts:207`), never imports/deps · runtime pxe/wallets/noir boundary still ∅.

## Next — P3 (three transports)
Keep WebHID + Speculos; **add `NodeHidTransport`** (`@ledgerhq/hw-transport-node-hid`, optional peer) + `./node-hid` subpath. `autoConfirm` stays Speculos-only.
