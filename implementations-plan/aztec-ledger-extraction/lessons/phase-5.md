# Phase 5 — build (tsup) + docs → DONE (green)

Two parts: 1. SDK tsup build + README — DONE. 2. same for `core` — DONE.

## Part 1 — SDK build + docs → DONE (green). The flagged SPIKE PASSED.
`tsup.config.ts`: 6 entries (root barrel + each subpath), `format: ['esm']`, `dts: true`, `splitting: true`, `treeshake`, `clean`, `sourcemap`.

### Spike outcome — all the feared failure modes were non-issues
- **ESM build: success (≈70ms).** Bundles are KB-sized → `@aztec/*` stayed external (not bundled). Splitting put shared internal modules into `chunk-*.js` (no duplication across the 6 entries).
- **DTS build: success (≈1.3s).** `index.d.ts` + 5 subpath `.d.ts` + shared `.d.ts` chunks.
- **The 150 `.ts`-extension imports + `verbatimModuleSyntax`** were a non-issue: bundling+splitting resolves/inlines internal `./foo.ts` (they never appear as emitted specifiers); only externals stay as bare imports.
- **The 29 deep `@aztec/*` subpaths**: handled by REGEX externals `/^@aztec\//` (+ `/^@ledgerhq\//`, `/^@noble\//`, core). A bare-name external is NOT guaranteed to cover subpaths — the regex is the de-risk.

### The one real gotcha
`tsup`'s dts pass injects `baseUrl`, and **TypeScript 6 makes `baseUrl` a hard error** (`TS5101`, deprecated). Fix: `"ignoreDeprecations": "6.0"` in the root `tsconfig.json` (the project config tsup reads). Without it the ESM build succeeds but the DTS build fails.

### Packaging (publish-quality, private)
- Root `exports` stays `./src/*.ts` so the WORKSPACE dev loop (demo/tests) runs from source — no rebuild per change.
- `publishConfig.exports` maps each subpath to `./dist/*.{js,d.ts}` — applied only at publish. `files: ["dist","src","README.md"]`. `dist/` is gitignored (rebuilt, never committed).
- `README.md`: install (+ the `@aztec/*` peers), a connect example, the transport subpath table, the **honest spend-vs-viewing-key disclosure** (spend key device-only; viewing root revealed to host under approval; `./advanced`+`./unsafe` are outside the fail-closed guarantees), and the firmware↔SDK co-versioning rules (handshake range/caps vs the consumer's optional registry).

## Validation (green)
`lint:all` 0 · `bun test packages/` 134 pass · `bun run build` (tsup) exit 0, ESM+`.d.ts` for all 6 entries · demo unaffected (workspace exports still source).

## Part 2 — core build + docs → DONE (green)
`@alejoamiras/aztec-ledger-core` got the same: single-entry `tsup.config.ts` (ESM+`.d.ts`, `/^@aztec\//` external), `build` script, `files`, `publishConfig` → `dist/`, a short README, and its 4 `@aztec/*` moved deps→peers+devDeps (consistent with the SDK; the consumer's single `@aztec/*` install satisfies both). `bun run build` exit 0 (ESM + `dist/index.d.ts`).

## Next — P6 (validation)
Standalone consumer-smoke against the BUILT `dist/` (import + a transport → derive an address) + the boundary git-grep. The Speculos matrix "from the package" + the demo onboard/smoke e2e are MANUAL (no emulator/network here).
