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
- [ ] Run demo against real `trezor-firmware` emulator → M0b green for Trezor + Path A K1
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

- [ ] Custom device app skeleton (raw-digest secp256k1 signing via `cx_ecdsa_sign_rs_no_throw` + `CX_RND_RFC6979`)
- [ ] On-device manifest verification (Poseidon2)
- [ ] Ledger Live submission + audit engagement

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
