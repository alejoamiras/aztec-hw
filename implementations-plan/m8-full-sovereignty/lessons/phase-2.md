# Phase 2 — BN254 base field arithmetic (`gk_fq_t`)

**Status:** code complete; validation deferred (host-build CLI lands in Phase 3 with parity oracle).
**Branch:** `m8-phase-2-bn254-fq`.

## What's done

- `ledger-app/scripts/gen-fq-params.ts` — codegen for the Montgomery constants
  (p, R², µ) of BN254 BASE field = Grumpkin scalar field.
  ```
  p_fq  = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
  R²    = 0x06d89f71cab8351f47ab1eff0a417ff6b5e71911d44501fbf32cfc5b538afa89
  µ     = 0x87d20782e4866389
  ```
- `ledger-app/src/crypto/grumpkin/fq_params.{c,h}` — generated; emits as 4 × u64
  little-endian limbs.
- `ledger-app/src/crypto/grumpkin/fq.{c,h}` — CIOS Montgomery arithmetic
  (zero, set, eq, from_bytes_be, to_bytes_be, from_u64, add, sub, mul, sqr).
  Algorithm structure cloned from `crypto/poseidon2/fr.c` (identical shape);
  only the parameter constants differ.
- **Codex final-audit BLOCKER #1 closed at the type level:** `gk_fq_t` is a
  distinct struct from `fr_t`. The header explicitly documents the prime
  difference and forbids aliasing. The compiler enforces it (incompatible
  pointer types).

## What's deferred

- **Wide reduction `gk_fq_from_bytes_wide_be(64 B → gk_fq_t)`** — needed by
  Phase 6 (SHA-512 output → Grumpkin scalar for viewing keys). Defer to Phase
  3 or 6 when the consumer exists. Naive impl: 64 iterations of `(acc * 256 +
  byte) mod p` via existing primitives. Faster impl: split as `hi · R + lo
  mod p` using AZ_FQ_R2 to handle the upper half; ~2 muls + 1 add.
- **Modular inverse `gk_fq_inv`** — needed by Phase 3's Jacobian → affine
  conversion. Defer to Phase 3; implementation via Fermat's little theorem
  (`a^(p-2) mod p`) reuses `gk_fq_sqr` + `gk_fq_mul`.
- **Host-build CLI + parity test** — needs `ledger-app/tests/grumpkin_fq_host/`
  mirror of `poseidon2_host/` (Makefile + main.c that stdin/stdout-tests a
  CLI built from the same .c sources). Defer to Phase 3 where Grumpkin EC
  parity testing needs the same infra anyway.

## Constant-time discipline

The arithmetic mirrors `fr.c`. Per `fr.h`, `fr.c`'s threat model explicitly
allows non-CT (Poseidon2 operates on public manifest data). **Phase 2's
`fq.{c,h}` inherits this caveat but Phase 3's scalar-mult layer operating on
PRIVATE viewing scalars needs CT guarantees one level up.** The current
add/sub/mul are branch-free in their inner loops, but the final
"if (ge_p) subtract" branches on data. For Phase 9 (adversarial hardening),
this becomes a constant-time conditional move via bitmask selection. PoC
threat model accepts the leak; production-bar fix lands with Donjon audit.

## Why not alias `fr_t`?

Codex final-audit BLOCKER #1 traced this carefully. The two primes differ
in their bottom 16 bytes:

```
p_fr = 0x30644e72e131a029_b85045b68181585d_2833e84879b97091_43e1f593f0000001
p_fq = 0x30644e72e131a029_b85045b68181585d_97816a916871ca8d_3c208c16d87cfd47
              SAME              SAME           DIFFERENT        DIFFERENT
```

So `AZ_FR_R2 ≠ AZ_FQ_R2`, and `AZ_FR_MU ≠ AZ_FQ_MU`. Aliasing
`typedef fr_t gk_fq_t` would silently misderive every Grumpkin scalar mult
because the Montgomery reduction would use the wrong modulus constants.
The compiler catches this at the type level today.

## Validation status

- TS codegen ran successfully; constants match expected values (verified
  against `aztec-packages/yarn-project/foundation/src/curves/bn254/field.ts:360`
  `Fq.MODULUS`).
- C code is NOT yet compiled — Phase 3 brings the host-build CLI which is the
  first place anything links these sources. The BOLOS device build would also
  link them once Phase 3's `point.c` references `gk_fq_t`.
- 4000-vector parity test against `@aztec/foundation` Fq: deferred to Phase 3
  when host-build CLI exists.
