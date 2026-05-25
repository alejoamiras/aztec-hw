# Plan — hw-wallet-poc-v0

> Informal post-hoc plan capturing the autonomous-session build (2026-05-25). The Tier-A
> formal-protocol ceremony was explicitly skipped per user direction; this doc records what
> was built, against which decisions, and what's left.

## Source of truth

- **Upstream research recommendation**: `../../aztec-hardware-wallet/architectures/poc-recommendation.md`
- **v0 ship target** (per the decision matrix): ECDSA-K1 via Aztec's `EcdsaKAccount`, Trezor research adapter → Ledger production app.

## Phase A — Trezor blind-sign internal demo (this session)

### Goals

1. Working `TrezorEcdsaKAuthWitnessProvider` adapter that conforms to Aztec's `AuthWitnessProvider` interface.
2. End-to-end demo proves the adapter pipeline produces signatures Aztec's verifier accepts.
3. Real transport against a Trezor (emulator or device) scaffolded — emulator round-trip is the M0b gate.

### Status (after autonomous session)

| Goal | Status | Where |
|---|---|---|
| Project scaffolding (Bun + Biome + Husky + workspaces) | ✓ done | commit `d17f31c` |
| Shared types: `IntentAuthWitnessProvider`, `CallIntent`, ECDSA helpers | ✓ done | `packages/core` |
| Trezor adapter — IdentityType protobuf, compressed pubkey, marker strip, low-s | ✓ done | `packages/adapter-trezor` |
| Demo round-trip with Trezor-faithful fake transport | ✓ done — `OK ✓` | `apps/demo` |
| Codex adversarial review of adapter | ✓ done | `lessons/phase-A-codex-review-1.md` |
| Architecture pivot per codex review | ✓ done | commit `f5125d2` |
| GitHub Actions CI (lint + typecheck + test + actionlint) | ✓ done | `.github/workflows/ci.yml` |
| Real transport via Python `trezorlib` subprocess | ✓ done | `TrezorlibSubprocessTransport` + `scripts/trezor-bridge/` |
| Codex adversarial review of bridge transport | ✓ done | `lessons/phase-A-bridge-codex-review-2.md` |
| Real-emulator round-trip (M0b for Trezor + Path A K1) | ⏳ next session | needs emulator running |
| Phase 0 — M0a baseline (`e2e_account_contracts.test.ts`) | ⏳ deferred | needs aztec-packages bootstrap (heavy) |

### Key design decisions (this session)

1. **Identity = `IdentityType` protobuf, not URL string**. `proto='gpg'` mandatory for raw `challenge_hidden` signing. Codex finding #1 (review 1).
2. **Pubkey: 33-byte compressed via SignIdentity, decompressed to 64-byte `X ‖ Y`**. Aztec's `EcdsaKAccount` constructor wants 64 bytes (no prefix). Codex finding #2 (review 1).
3. **No separate `GetPublicKey` API**. Pubkey comes back as a side effect of `SignIdentity`. Adapter caches first return; demo issues a probe-sign to populate. Codex finding #3 (review 1).
4. **Signature marker byte (signature[0]) = `0x00`** in gpg/ssh sigtypes (Trezor overwrites). Strip and ignore. Codex finding #5 (review 1).
5. **Real transport via Python subprocess** (not pure-JS). Codex finding #4 (review 1) — stock `TrezorConnect.requestLogin` is too limited; pure-JS via `@trezor/transport` + `@trezor/protobuf` is a 2-4 engineer-day investment per codex review 2.
6. **Aztec verifier integration**: pass raw `outer_hash.to_be_bytes()` to `Ecdsa.verifySignature`; Aztec internally SHA-256s. Codex finding #7 (review 1).
7. **`Option A` clear-signing interface** stub in `packages/core/src/provider.ts`. `IntentAuthWitnessProvider extends AuthWitnessProvider` with `createAuthWitFromIntent(intent: CallIntent)`. Phase B work to implement on-device.

### Carry-forwards (open items)

- **M0b emulator round-trip** — needs `trezor-firmware` emulator running. Setup steps in `docs/setup-trezor-emulator.md`. Expected output: same `OK ✓` as the fake-transport demo, but signed by the actual emulator.
- **M0a baseline** — `e2e_account_contracts.test.ts` from `aztec-packages` green locally. Requires aztec-packages bootstrap (yarn install + barretenberg build, hours). Deferred.
- **Aztec address derivation** from device pubkey — documented (codex review 1 finding #8 cites `getContractInstanceFromInstantiationParams` + `CompleteAddress.fromSecretKeyAndInstance`). Not yet implemented.
- **Device-flow coverage** — Trezor One PIN + host-side passphrase NOT supported by the `ClickUI`-based bridge (codex review 2 finding #1). Acceptable for Phase A; revisit with `ScriptUI` or pure-JS for broader coverage.

## Phase B — Aztec SDK clear-signing extension (future)

- Open the upstream PR adding `createAuthWitFromIntent` to `AuthWitnessProvider` (or sibling method).
- Implement on-device manifest reconstruction + `outer_hash` recomputation in the Trezor app (custom firmware fork, or — if Phase A.7 lands first — in a pure-JS adapter that pre-computes for the device).
- Reference: `../../../aztec-hardware-wallet/architectures/02-clear-signing-interface.md`.

## Phase C — Ledger production app (future)

- Custom Ledger device app: secp256k1 raw-digest signing via `cx_ecdsa_sign_rs_no_throw(CX_RND_RFC6979, ...)`.
- On-device manifest verification (Phase B prereq).
- Ledger Live submission + audit.
- Reference: `../../../aztec-hardware-wallet/architectures/ledger/research-codex.md`.

## Reviews & lessons

- [`lessons/phase-A-codex-review-1.md`](lessons/phase-A-codex-review-1.md) — codex review of initial scaffolding + adapter; 8 findings, all addressed in the pivot commit.
- [`lessons/phase-A-pivot-after-codex.md`](lessons/phase-A-pivot-after-codex.md) — what changed in code per review 1; before/after table of assumptions.
- [`lessons/phase-A-bridge-codex-review-2.md`](lessons/phase-A-bridge-codex-review-2.md) — codex review of bridge transport; 3 findings, all addressed.
- [`lessons/phase-A-codex-sessions.txt`](lessons/phase-A-codex-sessions.txt) — codex session IDs for follow-ups.

## How to verify

```bash
bun install --frozen-lockfile
bun run lint:all
bun run typecheck
bun test                          # 26/26
bun run --cwd apps/demo start     # → "OK ✓"
```

CI mirrors this in `.github/workflows/ci.yml`.
