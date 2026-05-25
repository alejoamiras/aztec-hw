# ledger-app-aztec (PoC scaffolding)

Custom Ledger BOLOS app for Aztec Network. **Currently a skeleton** — no compiling C code yet. See [`PORTING-PLAN.md`](PORTING-PLAN.md) for the build-out strategy.

## Why this exists

The Trezor adapter in `../packages/adapter-trezor/` rides Trezor's generic `SignIdentity` primitive — no firmware changes. Ledger has no such generic surface, so to support Aztec, we have to ship **our own Ledger app**.

The app's job:
1. Hold the Aztec signing key derived under SLIP-0013 (or an Aztec-specific BIP-44 coin type — pending decision).
2. Accept an Aztec call manifest from the host, render a confirmation screen, and sign the corresponding `outer_hash`.
3. (Stretch) Implement Schnorr-over-Grumpkin natively on-device so Aztec's canonical `SchnorrAccount` works with hardware-wallet signing.

## Target devices (in order of priority)

- Ledger Stax + Flex — best UX for Aztec's rich tx summaries (color touchscreen)
- Ledger Nano X — BLE coverage
- Ledger Nano S+ — lower-bound budget testing

## Roadmap (ledger-app-specific)

| Milestone | Status |
|---|---|
| L1 — Scaffold + porting plan + build container | 🟡 in progress (this commit) |
| L2 — K1 path: sign Aztec `sha256(outer_hash.to_be_bytes())` via stock `cx_ecdsa_sign_rs_no_throw(CX_RND_RFC6979)`, no porting required, basic blind-sign UI | pending |
| L3 — Speculos emulator harness + golden vectors against `EcdsaKAccount` | pending |
| L4 — Clear-signing UI: render the Aztec call manifest, do on-device Poseidon2 + `outer_hash` reconstruction | pending — needs Poseidon2 port |
| L5 — Grumpkin port: Schnorr-over-Grumpkin native (the "groundbreaking" path) | pending — biggest lift, ~weeks |
| L6 — Ledger Live submission + mandatory audit | pending (post-L4) |

## Build (once C code exists)

```bash
# Uses Ledger's official builder image (pulled in this session, see HANDOFF.md)
docker run --rm -it -v "$(pwd):/app" \
  ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest \
  make -j BOLOS_SDK=/opt/nanosplus-secure-sdk
```

Test via Speculos (Ledger's emulator):

```bash
speculos --model nanosp /app/bin/app.elf
```

(See [`PORTING-PLAN.md`](PORTING-PLAN.md) §3.)
