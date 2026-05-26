# Roadmap

## Phase A — Trezor blind-sign internal demo (in progress)

**Target**: a signed Aztec `outer_hash` from the Trezor emulator that the Aztec `EcdsaKAccount` in-circuit verifier accepts end-to-end.

- [x] Project scaffolding (Bun + Biome + Husky + workspaces + bunfig)
- [x] `packages/core` — shared types: `CallIntent`, `AuthWitnessFromIntent` interface extension (Option A shape); ECDSA helpers
- [x] `packages/adapter-trezor` — `TrezorEcdsaKAuthWitnessProvider` against the `IdentityType` protobuf SignIdentity API
- [x] `apps/demo` — CLI proves the adapter pipeline round-trips through Aztec's TS verifier with a Trezor-faithful fake transport
- [x] Codex review of scaffolding + adapter (lessons captured in `implementations-plan/hw-wallet-poc-v0/lessons/`)
- [x] Real transport via Python `trezorlib` subprocess bridge — `TrezorlibSubprocessTransport`
- [x] GitHub Actions CI (lint + typecheck + test + actionlint)
- [x] **M0b green** — demo runs against real `trezor-firmware` emulator (T2T1 in Docker via `trezor-user-env`), signature verifies through Aztec's TS `Ecdsa.verifySignature`. See [`lessons/phase-A-real-emulator-roundtrip.md`](../implementations-plan/hw-wallet-poc-v0/lessons/phase-A-real-emulator-roundtrip.md).
- [ ] M0a baseline verification (`e2e_account_contracts.test.ts` from `aztec-packages` green locally)

## Phase A.7 — Pure-JS transport (after Phase A ships)

Replace the Python subprocess with a `@trezor/transport` + `@trezor/protobuf` JS client. Removes the Python dep; lets the adapter run in browser-extension contexts. Higher engineering cost — codex called it the "lowest JS-only escape hatch" — but cleaner production end-state.

## Phase B — Aztec SDK extension + on-device manifest

**Target**: clear-signing capability via interface extension.

- [ ] Draft `createAuthWitFromIntent(intent: CallIntent)` extension shape
- [ ] Reference embedded Poseidon2 implementation (or Foundation funding decision)
- [ ] Trezor adapter: device-side manifest reconstruction + verification
- [ ] Aztec SDK PR for the interface extension

## Phase C — Ledger production v0

**Target**: Ledger custom device app on Ledger Live.

Detailed plan in [`../implementations-plan/hw-wallet-poc-ledger/plan-final.md`](../implementations-plan/hw-wallet-poc-ledger/plan-final.md).

- [x] **L1 — scaffold + porting plan + `ledger-app-builder-lite` verified**
- [x] **L2 — K1 baseline app**: buildable for nanosp/nanox/stax/flex; `GET_PUBLIC_KEY` returns 64B `x ‖ y`; `SIGN_OUTER_HASH` returns low-S `r ‖ s` after device-side `sha256(outer_hash)` + RFC-6979 ECDSA-K1 + fault-injection duplicate-check defense; `nbgl_useCaseReviewBlindSigning` UI with "INTERNAL — DO NOT SHIP" banner
- [x] **L2b — sig verifies via Aztec barretenberg `Ecdsa.verifySignature`** (same code path the in-circuit `EcdsaKAccount` verifier runs)
- [x] **Speculos integration harness**: 10/10 passing (`SPECULOS_URL=http://localhost:5001 bun test packages/adapter-ledger`)
- [x] **Cross-vendor demo CLI**: `AZTEC_HW_TRANSPORT=fake|trezorlib|ledger` swaps backends behind the same `IntentAuthWitnessProvider`
- [x] **CI workflow** — per-package gate, docker image digests pinned (plan §7), build matrix across all four target SDKs, speculos integration test on nanosp
- [ ] L3 — full pytest harness (multi-device + golden vectors pinned to aztec-packages commit)
- [ ] L4 — clear-signing on-device (Poseidon2 port + manifest streaming via BEGIN_AUTHWIT/APPEND_CALL/FINALIZE_AND_SIGN)
- [ ] L5 — Schnorr-Grumpkin native (multi-week, audit-gated)
- [ ] L6 — Ledger Live submission + mandatory audit (post-L4, foundation-gated)

## Decisions log

- **2026-05-25**: v0 scheme = **ECDSA-K1** (per `../aztec-hardware-wallet/architectures/08-decision-matrix.md`).
- **2026-05-25**: First PoC vendor = **Trezor** (research velocity); production target = **Ledger**.
- **2026-05-25**: Clear-signing interface = **Option A** (sibling `createAuthWitFromIntent` on `AuthWitnessProvider`).
- **2026-05-25**: Recovery design = **Design C** (passphrase + HW-derived KEK 2-of-2) + **Design D** (paper / SLIP-39 Shamir emergency).
- **2026-05-25**: GridPlus Lattice1 = **eliminated** for v0 (no public raw-digest signing API; default cloud-routing privacy footgun).
- **2026-05-25**: Path B (Schnorr-Grumpkin native) = **research-only** across all vendors.

## Open items (Foundation decisions)

1. Fund reference embedded Poseidon2 implementation (~2-4 weeks one-time)?
2. Aztec SLIP-44 coin type — register or use non-registered convention?
3. Ledger audit budget approval ($15-30k estimated, unverified).
4. Canonical account-contracts registry — Foundation publishes?
5. `outer_hash` versioning policy for HW-app upgrade-skew.
