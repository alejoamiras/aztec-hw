# Implementation Plans — Index

- [hw-wallet-poc-v0](hw-wallet-poc-v0/plan.md) — PoC implementation. Phase A (Trezor emulator) → Phase B (Aztec SDK extension) → Phase C (Ledger production). Phase A + B complete; Phase C in progress.
- [hw-wallet-poc-ledger](hw-wallet-poc-ledger/plan-final.md) — Ledger BOLOS app. **L2 K1 baseline complete** (Speculos sign-flow + acceptance test via Aztec `Ecdsa.verifySignature`). **L3 ragger harness complete** (nanosp + nanox). **L4 verified-calls signing complete end-to-end**: device parses streamed manifest, recomputes outer_hash via L4.1 Poseidon2 oracle (host parity 14/14), gates signing on host/device parity + 3× fault-hardened recompute, renders per-call review (Target/Selector/Mode/outer_hash). Adapter switched from decorative `createAuthWit` to manifest streaming; 66/66 bun tests + Aztec barretenberg `Ecdsa.verifySignature` against device pubkey. L5 (Grumpkin Schnorr) deferred to audit-gated phase.

> The upstream research plan that informed this work lives in `../../aztec-hardware-wallet/implementations-plan/hw-wallet-research/`.
