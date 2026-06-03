# Phase 0 step 0 — rename packages → DONE (green)

`packages/adapter-ledger` → `packages/aztec-ledger`; names `@aztec-hwwallet-poc/adapter-ledger` → `@alejoamiras/aztec-ledger-sdk` and `@aztec-hwwallet-poc/core` → `@alejoamiras/aztec-ledger-core` (placeholder scope).

## What changed
- `git mv` the dir (history preserved).
- Bulk-renamed the package names + all ~importers (demo `package.json` + 7 demo `src` files + the package's own files) + the codegen scripts' internal `packages/adapter-ledger` path strings + `manifest.json`.
- `bun install` re-linked the workspaces (new `bun.lock`).
- Cleaned a stale `Mirrors @aztec-hwwallet-poc/adapter-trezor` (dissolved pkg) from the SDK description.
- LEFT the demo app's own name `@aztec-hwwallet-poc/demo-browser` (private app, not part of the publish surface).

## Lessons
- **System `sed` is GNU 4.9, not BSD** — `sed -i ''` fails (`''` parsed as the script → "can't read s|…"). Use GNU `sed -i 's|…|…|g'` (no `''`). (`git mv` had already run as the first `&&` link, so only the seds needed redoing.)
- **The rename reshuffles alphabetical order** → BOTH `sort-package-json` (dep keys: `@alejoamiras/*` now sorts before `@aztec/*`) AND biome `organizeImports` (import specifiers) flagged it. Fix: `sort-package-json <pkgs>` + `biome check --write <dirs>` (auto-fixed 16 files).

## Validation (green)
`bun run lint:all` exit 0 · `bun test packages/` 135 pass / 0 fail · `tsc` (renamed pkg) no NEW errors (only the 3 pre-existing `noUncheckedIndexedAccess` test files) · demo `tsc` clean.

## Next (P0 a→c)
(a) demo gains direct `@aztec/pxe` + `@aztec/wallets` deps; (b) move `session-embedded-wallet.ts` + `aztec-ledger-session.ts` (+ later preflight/registry) to the demo, repoint `state.ts` + session tests; (c) cut the pure root barrel LAST.
