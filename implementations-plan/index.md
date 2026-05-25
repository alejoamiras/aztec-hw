# Implementation Plans — Index

- [hw-wallet-poc-v0](hw-wallet-poc-v0/plan.md) — PoC implementation. Phase A (Trezor emulator) → Phase B (Aztec SDK extension) → Phase C (Ledger production). Phase A + B complete; Phase C in progress.
- [hw-wallet-poc-ledger](hw-wallet-poc-ledger/plan-final.md) — Ledger BOLOS app, tier-A consolidated plan + final critique. **L2 (K1 baseline) complete**: app boots in Speculos, signs sha256(outer_hash), 5/5 integration tests green against `@noble/secp256k1`. L3 (golden vectors) deferred → L4 (clear-signing) deferred → L5 (Grumpkin Schnorr) deferred.

> The upstream research plan that informed this work lives in `../../aztec-hardware-wallet/implementations-plan/hw-wallet-research/`.
