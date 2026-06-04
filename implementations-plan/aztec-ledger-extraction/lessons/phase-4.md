# Phase 4 — production API + version handshake (IN PROGRESS)

P4 has three parts; doing them as separate validated commits:
1. **version+caps connect handshake** — DONE (this commit)
2. `connectLedger` factory + convenience flow — pending
3. `@aztec/*` → `peerDependencies` — pending (workspace-resolution-risky, do last)

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

## Next (P4 cont.)
`connectLedger` factory (+ `LedgerConnection`/convenience account flow), then `@aztec/*` → peerDeps (move deps→peers + ensure the demo provides ALL of them incl. `@aztec/accounts`; the SDK likely needs them as devDeps too so its own tests/build resolve — verify empirically).
