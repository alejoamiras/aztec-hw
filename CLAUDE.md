# Project: aztec-hardware-wallet-poc

Hardware-wallet signing PoC for Aztec Network. Companion to research at `../aztec-hardware-wallet/architectures/`.

## Source-of-truth pointers

- **Research recommendation**: `../aztec-hardware-wallet/architectures/poc-recommendation.md`
- **Decision matrix**: `../aztec-hardware-wallet/architectures/08-decision-matrix.md`
- **Aztec signing surface anchor**: `../aztec-hardware-wallet/architectures/00-aztec-signing-surface.md`
- **Clear-signing interface design**: `../aztec-hardware-wallet/architectures/02-clear-signing-interface.md` (Option A recommended)
- **Recovery design**: `../aztec-hardware-wallet/architectures/03-recovery-and-backup.md` (Design C + D)
- **Security review**: `../aztec-hardware-wallet/architectures/06-security-adversarial-review.md`
- **Aztec source-of-truth (local clone)**: `/Users/alejoamiras/Projects/aztec-packages/`

## v0 target

- **Scheme**: ECDSA-K1 (`EcdsaKAccount`).
- **Phase A** (current): Trezor emulator + `SignIdentity`/`trezorlib` → blind-sign internal demo.
- **Phase B**: Aztec SDK extension `createAuthWitFromIntent` (Option A from clear-signing design) + on-device manifest verification on Trezor.
- **Phase C**: Ledger custom device app + Ledger Live audit + submission.

## Conventions

Inherits `~/.claude/CLAUDE.md`. Project specifics:

- **Bun for everything** (PM, runtime, test runner, scripts). No npm/yarn/pnpm.
- **Biome** for lint + format. No ESLint/Prettier.
- **bun:test** for SDK packages. Vitest for React if `apps/demo` grows a UI.
- **7-day npm `minimumReleaseAge`** is non-negotiable (`bunfig.toml`).
- **Conventional commits** enforced via commitlint.
- **No L1 dependencies** by default (no wagmi/viem/ethers).
- **Aztec dependencies** consumed from npm (`@aztec/*`), not from the local `aztec-packages` clone.

## Critical Aztec facts (from research)

- Signature schemes verified in-circuit: Schnorr-Grumpkin, ECDSA-secp256k1, ECDSA-secp256r1.
- ECDSA signature shape in `AuthWitness`: 64 bytes = `r(32) ‖ s(32)`. **No `v` byte.** **Not DER encoding.**
- ECDSA preimage: `sha256(outer_hash.to_be_bytes())` (NOT EIP-191, NOT Keccak-256).
- `signing_public_key` on standard account contracts is `SinglePrivateImmutable` — **no rotation entrypoint**.
- Protocol keys (`ivsk_m`, `ovsk_m`, etc.) stay host-side. HW wallet holds only the signing key.

## Validation gate (run before any commit)

```bash
bun run lint:all && bun test
```

## Hardware assumptions (Phase A)

- **No physical Trezor device required.** Use the official `trezor-firmware` emulator (https://docs.trezor.io/trezor-firmware/core/emulator/index.html).
- Emulator runs Safe 5 / Safe 3 / Model T firmware images locally.
- When physical hardware arrives (Safe 5 + Safe 3), the same transport-agnostic adapter code swaps emulator → device with no API change.
