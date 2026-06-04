# Phase 4 — production API + version handshake → DONE (green)

P4 had three parts, each a separate validated commit:
1. **version+caps connect handshake** — DONE
2. **`connectLedger` factory + convenience flow** — DONE
3. **`@aztec/*` → `peerDependencies`** — DONE

## Part 2 — `connectLedger` convenience factory → DONE (green)
New `src/connect.ts`:
- `connectLedger({ transport, signOptions?, preflight? })` runs the MANDATORY handshake (version range + **base** caps) eagerly and FAILS CLOSED — so a returned `LedgerConnection` is known-good ("fails closed at connect", as the ELI5 promised).
- `LedgerConnection.createAccount({ scheme?, accountIndex?, salt?, … })` picks the contract class (`LedgerEcdsaKAccountContract` / `LedgerSchnorrAccountContract`) and threads `defaultAztecPath(accountIndex)` + the connection defaults. It does NOT pass `curveId` — the Schnorr contract sets `GRUMPKIN`+`profileId:1` itself, ECDSA-K defaults to secp256k1.
- The per-account curve cap is still checked on first device use (the `getPublicKeyXY` handshake, P4-part1) — `connectLedger` only checks version + base caps because the scheme isn't known until `createAccount`.
- Exported `connectLedger` / `LedgerConnection` / `AccountScheme` / option types at root; updated the barrel header (these were the "lands in P4" placeholders).
- Tests (hardware-free): mock transport answering GET_VERSION/GET_CAPS → connect happy path + fail-closed-on-bad-version; `createAccount` class selection via a stub transport (construction touches no device).

## Part 1 — mandatory connect handshake → DONE (green)
New `src/connect-handshake.ts`:
- `SUPPORTED_APP_VERSION` = range `[0.1.0, 1.0.0)`; `assertDeviceCompatible(provider, requiredCaps)` runs **GET_VERSION** (must be in range) then **GET_CAPS** (must be a superset of `requiredCaps`), throwing typed `LedgerIncompatibleVersionError` / `LedgerMissingCapabilityError`.
- `requiredCapsForCurve(curveId)` = `CLEAR_SIGN | ATTEST_ADDRESS | (GRUMPKIN | K1)` — base safe caps + the scheme's signing curve.
- Enforced ONCE (cached `compatChecked`) at the top of `LedgerEcdsaKAuthWitnessProvider.getPublicKeyXY()` — the first device op in every safe account-setup path, so no account is built/signed against an incompatible device. The raw `./advanced` `LedgerProvider` deliberately bypasses it.
- This is the MANDATORY gate; SEPARATE from the OPTIONAL registry/manifest-id check (which rides the `ClearSignPreflight` hook, P1). Exported the errors + `assertDeviceCompatible` + the constants at root (the plan's "typed error classes" + "version/caps").

### Why it doesn't break the green suites
The shipped device is **0.1.0** with caps **0x1D** (`K1|CLEAR_SIGN|GRUMPKIN|ATTEST_ADDRESS`). 0.1.0 ∈ [0.1.0,1.0.0); `requiredCapsForCurve` for either scheme (0x15 K1 / 0x1C Grumpkin) ⊆ 0x1D. So the Speculos matrix stays green — confirm in manual QA (the handshake adds two NON-interactive APDUs, GET_VERSION + GET_CAPS, before the pubkey fetch; no extra approval walk). Offline `bun test packages/` is unaffected (the Speculos tests that hit `getPublicKeyXY` are offline-skipped).

## Validation (green)
`lint:all` 0 · `bun test packages/` **129 pass** / 0 fail (+5 handshake tests: per-curve caps, happy, version-too-low, version-too-high, missing-cap) · SDK `tsc` clean · demo `tsc` clean · `bun test apps/demo-browser` 21 pass · demo `vite build` ✓.

## Part 3 — `@aztec/*` → peerDependencies → DONE (green)
Moved the 5 `@aztec/*` (`accounts`, `aztec.js`, `entrypoints`, `foundation`, `stdlib`) out of the SDK's `dependencies`:
- → **`peerDependencies`** (pinned `4.2.1`) — the consumer controls the framework version (no duplicate installs / version skew).
- → **also `devDependencies`** (`4.2.1`) — REQUIRED so the SDK's own `bun test` / `tsc` resolve them; bun does NOT auto-resolve a workspace package's peers from a sibling.
- Demo gained `@aztec/accounts` (it already provided the other 4) so it satisfies every peer.
- `@ledgerhq/hw-transport*` + `@noble/secp256k1` + `core` stay regular deps; node-hid stays the optional peer.

Validation: `bun install` no-changes (same installed set, recategorized) · `lint:all` 0 · `bun test packages/` 134 pass · demo `tsc` clean · demo `vite build` ✓ · SDK `dependencies` has **no `@aztec/*`**; `peerDependencies` = the 5 + node-hid.

## Next — P5 (build + docs)
Add **tsup** (ESM + `.d.ts`) — the plan's flagged SPIKE: 150 `.ts`-extension imports, `verbatimModuleSyntax`, 29 `@aztec/*` deep-subpath externals + the node-hid optional-peer external; the `exports` map must mirror the build outputs. Then README (install, dev-firmware caveat, a connect example per transport, the honest spend-vs-viewing-key disclosure) + a firmware↔SDK co-versioning doc. Same for `core`.
