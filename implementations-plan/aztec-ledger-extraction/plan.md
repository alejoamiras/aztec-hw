# Plan — `aztec-ledger`: extract a publish-quality SDK (CONSOLIDATED)

> Deep-protocol output. Triangulated from 3 independent drafts — **A** (seed, git history), **B** `plan-boundary.md` (import-traced boundary), **C** `plan-dx.md` (consumer-API-first) — plus a **codex** pre-impl audit (`019e8f1c`). Tensions resolved inline. Opus + final-codex dual audit pending against THIS file.

## Goal (owner-set)
Carve the reusable Ledger↔Aztec signer out of `packages/adapter-ledger/` into a **publish-QUALITY but `private:true`** package `aztec-ledger` (stays private until the firmware is on Ledger Live). Keep `core` separate. Three transports (WebHID + node-hid + Speculos). `@aztec/*` → peer deps. **CI skipped.** Firmware + wire protocol **unchanged**. ECDSA-R1 dropped ([[ecdsa-r1-dropped]]).

## What triangulation settled (the load-bearing decisions)
1. **Boundary is real AND the surface must be cut first.** B's import trace: only `session-embedded-wallet.ts` → `@aztec/pxe`+`@aztec/wallets`; only `aztec-ledger-session.ts` → `@aztec/noir-contracts.js`; the `aztec-standards`/`noir` refs in `apdu.ts`/`l4-manifest.ts` are **comments**. But codex: the **root `index.ts` re-exports the session + transports**, so the leak is at the *public surface*. → **P0 cuts a pure root barrel first** (not "move session last").
2. **Registry coupling = one non-load-bearing seam → optional hook (NOT a RegistryBundle).** The only registry leak in the signing path is `preflightIntent` (`clear-signing-entrypoint.ts` → `preflight.ts` → generated tables). Preflight is a host-side **early-fail UX** check; the **device is the authoritative validator** (rejects unknown verbs/selectors on-chain-side regardless). → The SDK ships **no registry**; `preflight` becomes an **optional injected hook** the consumer supplies (with their firmware-matched registry) or omits. Resolves codex-HIGH-2 with B's lighter, correct fix.
3. **Codegen + `manifest.json` are firmware-shared, not SDK, not demo.** The codegen emits the device's C allowlist (`ledger-app/src/clear_signing_v0/`) too, and it imports `@aztec/noir-contracts.js`. → Relocate codegen + `manifest.json` to a **root/`ledger-app`-level codegen dir**; the SDK bundles **neither** (shipping it would re-introduce noir + break the boundary — codex-HIGH-3).
4. **A build step is mandatory.** Today: `noEmit` + raw `./src/index.ts` exports. Publish-quality needs a real emitter (**tsdown** → ESM + `.d.ts`). (C)
5. **Public API is consumer-first.** `connectLedger(opts)` → `LedgerConnection.createAccount({scheme})` → a `LedgerAztecAccount` usable with `@aztec/aztec.js`; **barrel 31 → ~12** (driver internals `LedgerProvider`/`INS`/`SW`/encoders demoted to internal); **typed error taxonomy** over `SW=0x…`. (C)
6. **Honest key-disclosure.** The *spend* key never leaves the device, but onboarding **reveals the viewing/privacy root to host memory by design** — "keys never leave" is false. → Precise wording + `reveal`/`onboarding` behind an **advanced subpath**. (codex-LOW)

## Package topology (after)
```
packages/
  core/            @scope/core         — framework-agnostic types (publish-quality, private, built w/ tsdown)
  aztec-ledger/    @scope/aztec-ledger — the SDK; deps: core + @aztec/{aztec.js,accounts,entrypoints,foundation,stdlib} as PEERS. NO pxe/wallets/noir. (private)
tools/clear-signing-codegen/  (or ledger-app/tools/) — manifest.json + gen-clear-signing → BOTH the firmware C tables and a TS registry artifact. NOT in the SDK.
apps/demo-browser/             — consumes aztec-ledger + core; OWNS the session, the generated demo registry, the demo contracts; gains direct @aztec/pxe + @aztec/wallets + @aztec/noir-contracts.js deps.
```

### SDK public surface (root, ~12 symbols)
`connectLedger`, `LedgerConnection`, `LedgerAztecAccount`, the account-contract factories (ECDSA-K, Schnorr), `assertDeviceAttestedAddress`, the typed error classes, the `LedgerTransport` **type**, the `ClearSignPreflight` hook **type**, version/caps types. **Subpaths:** `./webhid`, `./node-hid`, `./speculos` (concrete transports), `./unsafe` (raw signer), `./advanced` (reveal/onboarding/`LedgerProvider`). Root exports **no** concrete transport, **no** raw signer, **no** reveal.

## Phases
- **P0 — pure root barrel + boundary cut (do FIRST).** Author the new ~12-symbol root barrel + the subpaths; delete the compat re-exports of session/`SessionEmbeddedWallet`/concrete-transports from root. Move `session-embedded-wallet.ts` + `aztec-ledger-session.ts` + the demo registry to `apps/demo-browser`; add the app's new `@aztec/pxe`+`@aztec/wallets`+`noir` deps. Gate: `bun test` + demo build green; `git grep '@aztec/pxe|@aztec/wallets|@aztec/noir'` in `packages/aztec-ledger` = ∅.
- **P1 — registry seam.** Make `preflightIntent` an **optional injected hook** (`ClearSignPreflight`) on the account/connection options; SDK ships no registry. Demo supplies its generated registry as the hook. Device stays authoritative.
- **P2 — codegen relocation.** Move `gen-clear-signing-v0.ts` + `manifest.json` to the root/`ledger-app` codegen dir with explicit `--manifest/--out-c/--out-ts` flags; it emits the firmware C tables + the demo's TS registry. SDK depends on none of it.
- **P3 — three transports.** Keep WebHID + Speculos (exist); **add `NodeHidTransport`** (net-new, `@ledgerhq/hw-transport-node-hid`). Subpath-exported. `autoConfirm` stays Speculos-only (typed as optional; real transports = user taps).
- **P4 — production API + version handshake.** `connectLedger` + typed errors + the convenience account flow. Version negotiation: `GET_VERSION`/`GET_CAPS` **plus** firmware-version + registry/manifest identifier carried in the (consumer) registry bundle, **enforced in every safe constructor** (not just the factory — root no longer exports the raw `LedgerProvider`). `@aztec/*` → `peerDependencies` pinned `4.2.1`.
- **P5 — build + docs + types.** Add **tsdown** (ESM + `.d.ts`); curated `exports` map; README (install, dev-mode-firmware caveat, a connect example per transport, the honest spend-vs-viewing-key disclosure); a firmware↔SDK co-versioning doc. Same for `core`.
- **P6 — validation.** `bun test` + `tsc` + lint green from `aztec-ledger`/`core` in isolation; the Speculos matrix runs from the package; a **standalone consumer-smoke** (import the built `aztec-ledger` + a transport → derive an address); demo `smoke`+`onboard` e2e still green; the boundary `git grep` proof; build emits valid ESM+types.

## Security & Adversarial Considerations
- **Honest key model:** spend key device-only; **viewing/privacy root is disclosed to host memory under on-device approval** (the onboarding design) — documented plainly; `reveal`/`onboarding` live on `./advanced`, never root.
- **`./unsafe`** raw signer stays a separate, loud subpath (AHW-097); never root-reachable.
- **Firmware mismatch = fail closed:** the connect handshake (version + caps + registry/manifest id) rejects a device/SDK/registry mismatch; enforced in constructors, so a low-level path can't skip it. Device remains the authoritative validator (preflight is advisory).
- **Supply chain:** tiny direct dep set; `@aztec/*` + `@ledgerhq/hw-transport-*` as peers; 7-day min-age inherited; provenance/trusted-publisher deferred with publishing.
- **No secret persistence / no APDU-payload logging** in the moved set (AHW-048/080/081) — re-audit at extraction.
- **AHW-098 attested receive-address** is the default in `createAccount`, not opt-in (carry the codex-HIGH fix forward).
- **App fallout:** `apps/demo-browser` now holds the PXE/wallet/noir surface — its own threat model, out of the SDK's.

## Verification (DONE)
`lint:all` + `bun test packages/` + `tsc` (aztec-ledger + core isolated) + the build (tsdown emits ESM+`.d.ts`) exit 0 · Speculos matrix green from the package · standalone consumer-smoke derives an address · demo `smoke`/`onboard` e2e green · `git grep '@aztec/pxe|@aztec/wallets|@aztec/noir-contracts'` in `packages/aztec-ledger` = ∅ (boundary proof) · root barrel ≤ ~12 symbols, no concrete-transport/raw-signer/reveal at root.

## Risks / open
- **Session relocation = highest friction** (6 demo files re-wire) — do it inside P0 with the demo e2e as the guard.
- **node-hid native build** — optional peer + `./node-hid` subpath only.
- **Build introduction (tsdown)** may surface `.ts`-extension-import + ESM/CJS interop issues across the `@aztec/*` peers — spike early in P5.
- **Registry/manifest co-versioning** is a real contract; the handshake id + the codegen `--check` are the tripwires.

## Open decisions (confirm at approval)
1. **npm scope** for `@scope/{aztec-ledger,core}`. 
2. **Codegen home:** `tools/clear-signing-codegen/` (root) vs `ledger-app/tools/` — *rec:* root `tools/` (it's firmware+host shared).
3. **Glue home:** `apps/demo-browser` (rec) vs a thin `packages/demo`.
4. **Builder:** tsdown (rec) vs tsup/unbuild.

## Audit trail
Drafts: A (seed @ commit history), B `plan-boundary.md`, C `plan-dx.md`. Codex pre-impl `019e8f1c` (fix-plan-first → all 3 HIGH + 2 MED + 2 LOW folded above). **Pending: opus audit + final-codex review of THIS consolidated file → eli5.html (+ /goal + /loop seeds) → owner approval gate.**
