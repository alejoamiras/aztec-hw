# Implementation Plans — Index

- [hw-wallet-poc-v0](hw-wallet-poc-v0/plan.md) — PoC implementation. Phase A (Trezor emulator) → Phase B (Aztec SDK extension) → Phase C (Ledger production). Phase A + B complete; Phase C in progress.
- [hw-wallet-poc-ledger](hw-wallet-poc-ledger/plan-final.md) — Ledger BOLOS app. **L2 K1 baseline complete** (Speculos sign-flow + acceptance test via Aztec `Ecdsa.verifySignature`). **L3 ragger harness complete** (17 pass / 2 skip on nanosp + nanox). **L4.1 Poseidon2 host-parity complete** (portable Montgomery 4×u64 Fr, all 14 parity tests green vs aztec-packages `2770bcb…`; both device targets build). L4.3-7 (manifest state machine + verified-calls UI) next → L5 (Grumpkin Schnorr) deferred to audit-gated phase.

> The upstream research plan that informed this work lives in `../../aztec-hardware-wallet/implementations-plan/hw-wallet-research/`.
