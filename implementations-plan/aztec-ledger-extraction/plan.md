# Plan — `aztec-ledger`: extract a publish-quality SDK from the PoC

## Goal (owner-set)
Carve the reusable Ledger↔Aztec adapter out of `packages/adapter-ledger` into a **publish-QUALITY** package `aztec-ledger` that a third party can `import` and use to connect a **real Ledger** (dev-mode side-load) and get a usable Aztec account. Keep it **`private:true`** until the firmware is distributable (Ledger Live) — quality now, publish later. Ship **three transports** (WebHID + node-hid + Speculos). Keep **`core`** as its own package. **CI skipped** for now.

Non-goals: publishing to npm; Ledger Live submission; any firmware change; ECDSA-R1 (dropped — see [[ecdsa-r1-dropped]] / `architectures/08-decision-matrix.md`).

## Why this is safe to do now (and what it does NOT touch)
The firmware + wire protocol are **unchanged**. This is a host-TS repackaging. The boundary signal is concrete: the reusable adapter needs only `@aztec/{aztec.js,accounts,entrypoints,foundation,stdlib}`; the **PoC glue is exactly what drags in `@aztec/pxe` + `@aztec/noir-contracts.js`**. Getting those two deps OUT of `aztec-ledger` is the proof we drew the line correctly.

## Target topology (after)

```
packages/
  core/            @scope/core           — framework-agnostic intent/call/chain TYPES. (publish-quality, private)
  aztec-ledger/    @scope/aztec-ledger   — the SDK. depends on core; @aztec/* as PEER deps; NO pxe, NO noir. (publish-quality, private)
apps/demo-browser/                       — consumes aztec-ledger; OWNS the PoC glue (below)
```

### `aztec-ledger` (the SDK) — what moves IN (reusable)
- **Wire spec:** `apdu.ts` (INS/CAPS/CURVE_ID/SW/path helpers).
- **Provider:** `provider.ts` (the APDU driver) + `unsafe.ts` (the loudly-named raw-signer escape hatch — its own `./unsafe` subpath export, AHW-097 discipline).
- **Transports (behind `LedgerTransport`):** `transport.ts` (interface) + `speculos-transport.ts` + **new** `webhid-transport.ts` (`@ledgerhq/hw-transport-webhid`) + **new** `node-hid-transport.ts` (`@ledgerhq/hw-transport-node-hid`). Exposed via **subpath exports** (`aztec-ledger/webhid`, `/node-hid`, `/speculos`) so a browser bundle never pulls `node-hid` and vice-versa.
- **Account + signing:** `account-contract.ts` (ECDSA-K) + `schnorr-account-contract.ts`, `auth-witness-provider.ts`, `clear-signing-entrypoint.ts`.
- **Codec:** `l4-manifest.ts` + `deploy-context.ts` (manifest/deploy/address encoders) — **registry-AGNOSTIC** (see P3).
- **Identity:** `receive-address-verify.ts` (AHW-098 fail-closed gate), `oracle/` (host key-derivation parity), `master-secret.ts`, `secret-cache.ts`, `onboarding.ts`.
- **Codegen TOOL:** `scripts/gen-clear-signing-v0.ts` shipped as a package bin/export — consumers generate THEIR registry from THEIR manifest; the SDK ships the tool, not a registry.

### PoC glue — what moves OUT to `apps/demo-browser` (NOT in the SDK)
- `aztec-ledger-session.ts` (PXE wiring via `SessionEmbeddedWallet` + the pinned demo contracts + deploy/drip/transfer flows). **This is what pulls `@aztec/pxe`.**
- The generated `clear_signing_v0/*` registry + `clear-signing-v0/manifest.json` (pinned to the demo's USDC/ETH/Dripper/SponsoredFPC + deploy profiles). **The SponsoredFPC artifact is what pulls `@aztec/noir-contracts.js`.**
- The demo contract instances / `deployments.ts`.

## Phases

**P0 — boundary scaffold (no behavior change).** Create `aztec-ledger` package.json (name, `private:true`, `type:module`, deps = `core` + @aztec primitives). Move the reusable files in; move the glue to the app; fix imports. Gate: `bun test` + `tsc` green, demo app builds.

**P1 — three transports.** Finish/add `WebHIDTransport` + `NodeHidTransport` wrapping the `@ledgerhq/hw-transport-*` libs behind `LedgerTransport` (real transports leave `autoConfirm` unused — the user taps; Speculos keeps it). Subpath exports per transport.

**P2 — production API surface.** A curated `exports` map (root = the SDK; `./unsafe`, `./webhid`, `./node-hid`, `./speculos` subpaths). `@aztec/*` → **`peerDependencies`** (pinned `4.2.1`, documented as protocol-version-locked). A **connect-time version-negotiation guard** (`GET_VERSION` + `GET_CAPS` → reject an incompatible firmware, fail closed). An **error taxonomy** (typed errors over raw `SW=0x…` strings). A top-level `ledgerAztecAccount({ transport, bip32Path, scheme })` convenience entry.

**P3 — registry-agnostic codec.** The clear-signing codec takes a consumer-supplied registry (generated from their manifest via the shipped tool); the demo's registry generation moves to the app. The SDK bundles the **tool**, not the demo allowlist.

**P4 — docs + types.** README (install, the dev-mode-firmware caveat, a connect example per transport), a **firmware-coupling/versioning** doc (the SDK version ↔ firmware version contract; the GET_VERSION guard), precise public types (full inference at the boundary — owner's "well-typed package boundaries" rule). Split tests: unit + the Speculos integration suites move with the SDK; the demo e2e stays in the app.

**P5 — validation.** `bun test` + `tsc` green from `aztec-ledger` in isolation; the Speculos matrix (provider/m8/wire-reject-arms/verified-calls) runs from the package; a **new consumer-smoke** (a tiny standalone script: import `aztec-ledger` + a transport → derive an address) proving the SDK stands alone; the demo app still green (re-run smoke/onboard e2e); **`git grep` proves `aztec-ledger` has zero `@aztec/pxe` + `@aztec/noir-contracts.js`** (the boundary proof). Net LOC in the SDK should be < the old adapter (glue left behind).

## Security & Adversarial Considerations
- **Supply chain:** minimal direct deps; `@aztec/*` + `@ledgerhq/hw-transport-*` as peers; `bunfig.toml` 7-day min-age inherited; provenance/trusted-publisher deferred to the eventual publish (CI skipped now). The SDK adds attack surface to any consumer dApp — keep the dependency set tiny + auditable.
- **The `unsafe` raw-signer** stays a separate, loudly-named `./unsafe` subpath (never re-exported from root) — the AHW-097 lesson; a published SDK must not make blind-signing one import away.
- **Keys never leave the device.** Audit that nothing in the moved set persists/exfiltrates secrets: `secret-cache.ts` is memory-only (AHW-048), `oracle/` derives but doesn't store, no APDU-payload logging in the transports (AHW-080/081 — payloads carry account/tx metadata).
- **Firmware mismatch = fail closed.** The version-negotiation guard (P2) must reject a device whose `GET_VERSION`/`GET_CAPS` don't match the SDK's expected contract — a consumer with a stale firmware + new SDK (or vice-versa) must error, not mis-sign. The clear-signing registry must match the firmware's allowlist or decode fails — documented as the consumer's responsibility.
- **`receive-address-verify` (AHW-098)** ships IN the SDK + stays fail-closed; the convenience entry should make the attested-address path the default, not opt-in (carry the codex-HIGH fix forward).
- **Threat model:** a malicious consumer app embedding the SDK cannot extract keys (device-held) but can drive the signer — the on-device clear-sign review + approval is the backstop; the SDK must not offer a path that bypasses it (that's why `unsafe` stays gated + the entrypoint is the sanctioned seam).

## Verification (DONE = all green)
`bun run lint:all` + `bun test packages/` + `tsc` (aztec-ledger + core in isolation) exit 0 · Speculos matrix green from the package (relaunch on :5005) · consumer-smoke script derives an address · demo `smoke`+`onboard` e2e still green (:5001/:5180 env already up) · `git grep '@aztec/pxe'` and `'@aztec/noir-contracts'` in `packages/aztec-ledger` return nothing.

## Risks / open checks
- **Session extraction is the riskiest move** (most entangled with the demo); do it last in P0 with the app's tests as the guard.
- **`node-hid` is a native dep** (Node-only) → optional peer + subpath, so browser consumers never build it.
- **Codegen-as-a-tool**: the demo must regenerate its registry through the SDK's exported tool (prove the tool works from outside the SDK).
- **Co-versioning**: SDK↔firmware is a real contract; the GET_VERSION guard enforces at runtime, the README documents the mapping.

## Open decisions (confirm at approval — with my recommendation)
1. **npm scope/name** — `@scope/aztec-ledger` + `@scope/core`. *Rec:* your existing scope (or `@aztec-community/*` / a personal scope); the package name `aztec-ledger` regardless.
2. **Where the glue lands** — `apps/demo-browser` vs a new thin `packages/demo`. *Rec:* fold into `apps/demo-browser` (it's the only consumer; avoid a package that exists only to hold demo glue).
3. **`node-hid`** — optional peer (Node consumers add it) vs bundled. *Rec:* optional peer + `./node-hid` subpath.

## Audit protocol
Per "ultra plan": this draft → **codex audit** (adversarial review of the boundary, the peer-dep/versioning strategy, the security §, and whether the registry-agnostic codec is sound) → fold → owner approval gate → implement. (No opus/research-agent fan-out: well-understood refactor, full context in-repo — the value is the critical audit, not re-derivation.)
