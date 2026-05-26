# Implementation Plans — Index

- [hw-wallet-poc-v0](hw-wallet-poc-v0/plan.md) — PoC implementation. Phase A (Trezor emulator) → Phase B (Aztec SDK extension) → Phase C (Ledger production). Phase A + B complete; Phase C in progress.
- [hw-wallet-poc-ledger](hw-wallet-poc-ledger/plan-final.md) — Ledger BOLOS app. **L2 + L3 + L4 complete** (Speculos sign-flow + acceptance test via Aztec `Ecdsa.verifySignature`, ragger harness, verified-calls signing end-to-end with 3× fault-hardened recompute).
- [clear-signing-v0](clear-signing-v0/plan-final.md) — **M5 clear-signing arc, M5.0-M5.5 complete**: pinned manifest + codegen (selector cross-check fail-closed), wire v2 + raw args streaming, on-device args_hash recompute + strict allowlist (registry miss / decoder miss / arg-count desync / visibility mismatch / delegated-spend-unsupported), semantic UI (`Transfer 1.5 USDC From: you Mode: PUBLIC` rendered on Nano S+), host preflight, demo against alpha-testnet faucet USDC produces signature accepted by Aztec barretenberg. 74 bun tests + L4.1 host parity 14/14. **M5.6 deferred**: real on-chain submission needs PXE infra + LedgerWallet wrapper (see `clear-signing-v0/m5.6-submission-gap.md`). L5 (Grumpkin Schnorr) deferred to audit-gated phase.

> The upstream research plan that informed this work lives in `../../aztec-hardware-wallet/implementations-plan/hw-wallet-research/`.
