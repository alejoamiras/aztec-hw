# Phase 6 — validation → AUTONOMOUS parts DONE (green); device/network parts are MANUAL

## Autonomous DONE criteria — all green
- `bun run lint:all` exit 0
- `bun test packages/` **134 pass / 0 fail**; `bun test apps/demo-browser` 21 pass
- `tsc` (SDK + core, isolated) clean; demo `tsc` clean
- **Build** — `tsup` emits valid ESM + `.d.ts` for the SDK (6 entries) and core (1 entry), exit 0
- **Standalone consumer-smoke** (`tools/consumer-smoke/smoke.ts`) — imports the BUILT `dist/` as an outside consumer + a mock handshake transport; `connectLedger` passes the handshake (v0.1.0, caps 0x1d) and `createAccount` mints both the ECDSA-K and Schnorr contracts. Run: `bun tools/consumer-smoke/smoke.ts` (after `bun run build` in the SDK). Proves the built ESM + the `dist` exports + the public API are consumable.
- **Boundary git-grep proof** — `git grep '@aztec/pxe|@aztec/wallets|@aztec/noir-contracts' -- packages/aztec-ledger` = **∅**. SDK runtime `dependencies` carry no `@aztec/*` (they're peers).
- demo `vite build` ✓.

## MANUAL (this environment has no emulator/network)
These final DONE criteria need the user's QA, same boundary as the audit-c2 merge:
- **Speculos matrix "from the package"** — the device suites (`provider.test`, `provider.m8`, wire-reject arms, etc.) need a running Speculos emulator side-loaded with the app. Offline they're `skipIf`-skipped. The handshake added two NON-interactive APDUs (GET_VERSION/GET_CAPS) to the account path; the shipped 0.1.0/0x1D device satisfies the range+caps, so the matrix should stay green — confirm.
- **demo onboard/smoke e2e** — need the emulator + a testnet RPC.
- **consumer-smoke deriving a REAL on-chain address** — needs a device pubkey + the framework AccountManager + network; the offline smoke covers everything up to that.

## Status
P0–P5 are complete and green; P6's autonomous validations pass. The SDK is **functionally extracted, builds to publish-quality ESM+types, and is consumable** from its built output. What remains is device/network manual QA — the loop cannot flip those last criteria green without hardware.
