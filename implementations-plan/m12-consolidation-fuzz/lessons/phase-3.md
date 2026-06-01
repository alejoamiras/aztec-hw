# M12 Phase 3 — cx_math prototype-spike → cx-math-decision.md (DONE, → safe-v18)

## Outcome: ACCEPT THE RESIDUAL (Outcome C). Migration (A) gated on a real-silicon M13 eval.
Full reasoning + raw numbers in [`../cx-math-decision.md`](../cx-math-decision.md).

## What was built (throwaway, flag-gated `CX_MATH_SPIKE`)
- `ledger-app/src/handler/cxmath_spike.{c,h}` — INS `0x70`, computes `acc=a·bⁿ mod p` via `cx_bn_mod_mul` (modes 0/1, Fr/Fq) and native `fr_mul`/`gk_fq_mul` (modes 2/3). cx_bn API: `cx_bn_lock(32,0)` → `cx_bn_alloc_init` → `cx_bn_reduce` (operand precondition) → `cx_bn_mod_mul` loop → `cx_bn_export` → `cx_bn_unlock`.
- `ledger-app/tests/cxmath_spike/measure.ts` — drives the INS on Speculos; correctness vs BigInt reference + crude relative latency.
- **Build hook:** `Makefile` `DEFINES += $(EXTRA_DEFINES)` (empty by default). Spike build: `make … EXTRA_DEFINES=CX_MATH_SPIKE`.

## Flag-gated-off requirement — VERIFIED (B3/empty-diff gate holds)
- All P3 source additions are `#ifdef CX_MATH_SPIKE` (handler file, types.h INS, dispatcher include+case) → the **default build compiles zero new instructions**.
- The **B3 binding files** (`begin_deploy_account.c`, `finalize_deploy_and_sign.c`) are **NOT in the P3 diff** — untouched.
- Default build is **deterministic** (sha `a70167bb` stable across rebuilds). The +32 B vs the pre-P3 default (`dacc430a`) is **debug-info line-table shift** from the added (compiled-out) source lines in dispatcher.c/types.h — NOT a functional change; `.text` = 45650 B, unchanged. `bin/app.elf` restored to the default (production) build.

## Real numbers (the deliverable's spine)
- **Correctness: 8/8 vectors match** (`cx_bn === native === BigInt ref`) for **both** custom moduli (BN254 Fr `…f0000001` + Grumpkin Fq `…d87cfd47`), incl. `(p−1)²` (full reduction). ⟹ `cx_bn` accepts an arbitrary 254-bit modulus — the codex+opus "named-curve-only / silent wrong-field" failure mode is **disproven**. No correctness block ⟹ Outcome B not forced.
- **Latency (EMULATED, not silicon): cx_bn ~9× slower** (51.7 ms vs 5.8 ms / 4096 muls). Speculos = QEMU emulating the syscall, NOT the SE bignum unit → does NOT predict real-device latency (caveat 2). The perf trigger for Outcome A is therefore **unprovable here** (and weakly contraindicated).

## Why C (not A)
A needs the **perf+CT twofer**: correctness ✅, but "materially faster" is unmeasurable on Speculos (9× slower emulated, untrustworthy either way) and the CT benefit is a trust transfer (caveat 3) Speculos can't verify on silicon (caveat 2). Migrating now trades audited parity-locked native code for an SE dependency on faith in an unmeasured win. Mina/Zcash Ledger apps accept the same field-mul residual. ⟹ **accept now; gate A on M13 = real-silicon latency + scope/EM CT eval** (the measurement this arc fundamentally cannot make).

## Gotchas
- **APDU framing:** the raw frame is `CLA INS P1 P2 Lc data` — first measure run dropped the P2 byte (`e07000…` → device read P2=Lc, empty data → 6a87). Fixed to `e0700000<Lc>…`.
- cx_bn lives in the SDK's `ox_bn.h` (not `lcx_bn.h`); all `cx_bn_*` are `SYSCALL`s (real SE primitives, emulated by Speculos). `gk_fq_from_bytes_be`/`gk_fq_to_bytes_be` mirror the `fr_*` names.

(Committed UNSIGNED — 1Password SSH agent down this session; tag safe-v18 + push pending recovery.)
