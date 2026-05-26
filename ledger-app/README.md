# ledger-app-aztec (PoC — L2 K1 baseline)

Custom Ledger BOLOS app for Aztec Network. **L2 K1 baseline is live**: the app builds for all four target SDKs (nanosp / nanox / stax / flex), boots in Speculos, and produces an ECDSA-K1 signature that verifies under Aztec's actual barretenberg `Ecdsa.verifySignature` (same code path the in-circuit `EcdsaKAccount` verifier runs). See [`../implementations-plan/hw-wallet-poc-ledger/plan-final.md`](../implementations-plan/hw-wallet-poc-ledger/plan-final.md) for the full Tier-A plan, codex critique, and L3–L6 sequencing.

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
| L1 — Scaffold + porting plan + build container | ✅ done |
| L2 — K1 path: device-side `sha256(outer_hash.to_be_bytes())` + RFC-6979 ECDSA, low-S normalized, fault-injection duplicate-check, blind-sign UI | ✅ done — 10/10 Speculos tests; sig verifies under barretenberg Ecdsa |
| L3 — Speculos pytest harness + golden vectors against `EcdsaKAccount` | pending |
| L4 — Clear-signing UI: render the Aztec call manifest, do on-device Poseidon2 + `outer_hash` reconstruction | pending — needs Poseidon2 port |
| L5 — Grumpkin port: Schnorr-over-Grumpkin native (the "groundbreaking" path) | pending — biggest lift, ~weeks |
| L6 — Ledger Live submission + mandatory audit | pending (post-L4) |

## Build

```bash
docker run --rm -v "$(pwd):/app" -w /app \
  ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite@sha256:852e1def30b4b8377120df663ebff91e9fd9b7548ee1fd8c0a3ff74df708a162 \
  make BOLOS_SDK=/opt/nanosplus-secure-sdk
```

(Swap `nanosplus-secure-sdk` for `nanox-secure-sdk`, `stax-secure-sdk`, or `flex-secure-sdk` for other devices.)

Outputs land in `bin/app.elf` (Speculos), `bin/app.hex` (sideload via `ledgerctl`), and `bin/app.sha256`.

## Run against Speculos

```bash
docker run -d --rm --name speculos-aztec \
  -p 5001:5000 -p 9999:9999 \
  -v "$(pwd)/bin:/app" \
  ghcr.io/ledgerhq/speculos@sha256:9b414c3bcaecb7638224156d36a702d66af812a0aa59ca203ce7b34cf4d590ca \
  --display headless --model nanosp \
  --apdu-port 9999 --api-port 5000 \
  /app/app.elf
```

Then from the repo root:

```bash
SPECULOS_URL=http://localhost:5001 bun test packages/adapter-ledger
```

Or the cross-vendor demo CLI:

```bash
AZTEC_HW_TRANSPORT=ledger SPECULOS_URL=http://localhost:5001 bun run --cwd apps/demo start
```
