# Phase 3 — Grumpkin EC point arith + fixed-base [k]·G

**Status:** code complete + validated (256-vector bb.js parity green).
**Branch:** `m8-phase-3-grumpkin-ec`.
**Tests:** `bun test grumpkin-mul-parity.test.ts` → 3 pass / 0 fail, 524 expect() calls (~1s). Host smoke `make smoke` → `smoke OK`.

## THE critical finding: coordinate field ≠ scalar field

Grumpkin is the 2-cycle sister of BN254; its fields are SWAPPED relative to BN254. The plan text loosely called Phase 2's `gk_fq_t` "the field Grumpkin runs on" — that's **wrong** and would have been catastrophic if taken literally.

| Grumpkin role | = which BN254 field | modulus | our C type |
|---|---|---|---|
| BASE field (point coords x,y,Z; add/double arithmetic) | BN254 **scalar** | `0x...f0000001` | poseidon2 **`fr_t`** |
| SCALAR field (the `k` in [k]G, group order) | BN254 **base** | `0x...d87cfd47` | **`gk_fq_t`** (Phase 2) |

So **Phase 3 point arithmetic runs on poseidon2's `fr_t`, NOT on the Phase 2 `gk_fq_t`.** The scalar `k` is only read bit-by-bit; no `gk_fq` arithmetic happens in Phase 3 at all. Phase 2's `gk_fq_t` is still correct for its real purpose: Phase 6's SHA-512→scalar reduction (`sha512ToGrumpkinScalar`).

Verified two independent ways before writing a line of EC code:
1. **Empirically** (`/tmp/grumpkin-field-check.ts`): G = (1, 17631…860) satisfies y² = x³ − 17 ONLY over Fr (`0x...f0000001`), not over Fq.
2. **Source**: barretenberg `ecc/curves/grumpkin/grumpkin.hpp:59-60` — `ScalarField = bb::fq`, `BaseField = bb::fr`; and `:31` confirms `a = 0`.

This is the single most important thing in Phase 3. The 256-vector parity test is what proves we got it right — a wrong field would diverge on vector 1.

## Files

- `src/crypto/grumpkin/point.{c,h}` — Jacobian point ops over `fr_t`:
  `set_infinity`, `is_infinity`, `cmov` (constant-time select), `double`
  (dbl-2009-l, a=0), `add_affine` (madd-2007-bl, all edge cases), `to_affine_be`
  (one Fermat inverse), `affine_on_curve`. Includes a static `fr_inverse`
  (Fermat a^(p−2)) since poseidon2's fr.c has no inverse.
- `src/crypto/grumpkin/g1_generator.{c,h}` — G as BE byte constants
  (x=1, y=0x…272c). Loaded via `fr_from_bytes_be` at use (no Montgomery codegen).
- `src/crypto/grumpkin/mul_generator.{c,h}` — `grumpkin_scalar_mul_generator`,
  double-and-add-always over 256 bits.
- `ledger-app/tests/grumpkin_host/{Makefile,main.c}` — host CLI mirroring
  `poseidon2_host/`. Compiles fr.c + fr_params.c + the grumpkin/*.c + main.c.
- `packages/adapter-ledger/src/grumpkin-mul-parity.test.ts` — builds the CLI,
  runs 5 fixed + 256 random scalars, asserts byte-exact vs bb.js
  `Grumpkin.mul(generator, k)`.

## Algorithm choices (defended)

- **Double-and-add-always**, not the fixed-base comb the plan named. Rationale:
  correctness-first. The comb (4-bit signed-digit window + precomputed table)
  is a ~5× perf optimization that only matters once we benchmark on real
  Nano S+ (Phase 5, deferred per user). The comb, if added later, must match
  the SAME parity vectors — the test already exists. Documented in
  mul_generator.c.
- **Jacobian coordinates** — one inverse per scalar mult (at `to_affine`),
  not one per addition. Affine-only would have meant ~500 inversions per mul.
- **Generator stored as BE bytes**, converted via `fr_from_bytes_be` at runtime,
  rather than precomputed Montgomery limbs. Avoids a Montgomery-constant codegen
  step and its bug surface; cost is 2 `fr_mul` per scalar mult (negligible).

## Constant-time posture (PoC)

- The bit-processing layer IS constant-time: every one of the 256 bits does
  exactly one `double` + one `add_affine` + one `cmov` (bitmask select). No
  secret-dependent branch or table index.
- The underlying `fr_t` ops are NOT micro-constant-time (poseidon2/fr.h
  documents the final conditional subtract branches on data), and the rare
  edge-case branches in `add_affine` (`H==0`) branch on data. For random
  scalars those edge branches never fire; they exist for correctness, not
  timing. Production hardening (constant-time fr layer + the comb + Donjon
  audit) is Phase 9 / post-M8.

## Validation status

- ✅ Compiles host-side with `-std=c11 -O2 -Wall -Wextra -Wpedantic -Werror`.
- ✅ Smoke: [1]G=G, [2]G on-curve, [0]G=infinity.
- ✅ 256 random + 5 fixed scalars byte-exact vs bb.js.
- ⛔ NOT yet compiled under the BOLOS device toolchain — that link happens when
  Phase 6 references these from a handler. The host build uses the same C99
  sources, so the only device-specific risk is the `__uint128_t`-free 64×64
  path (already handled in fr.c / fq.c via the 4×32 decomposition, proven on
  the prior poseidon2 device build).
- ⛔ NOT benchmarked on real hardware (Phase 5 deferred per user; Speculos
  timing is meaningless for EC perf).

## Codex review outcome (session 019e73bc)

Verdict: **CHANGES-NEEDED, but NO formula bug.** Codex independently verified
`double` == EFD dbl-2009-l, `add_affine` == madd-2007-bl + barretenberg generic
Jacobian, `fr_inverse` correct (right modulus `AZ_FR_P`, borrow-free `e[0]-=2`,
valid square-and-multiply over Montgomery values), field choice correct, stack
< 7 KB, no portability blocker. It re-ran smoke + the Bun parity suite locally;
both passed.

Findings, all addressed in the follow-up commit:

1. **MAJOR — CT overstatement.** double-and-add-always is NOT fully
   constant-time: leading-ZERO bits of `k` take the infinity fast-path in
   `double(O)` / `add_affine(O,G)`, leaking the scalar's effective bit-length
   (hotter than the rare `H==0` branch). Fix: softened the docs in
   `mul_generator.{c,h}` + `point.h` to state plainly that the build is NOT
   side-channel-resistant and the leak exists; the genuine fix (infinity-free
   comb + constant-time fr layer) is Phase 9 / production. Per codex this
   honest-doc approach is acceptable for a PoC.
2. **MINOR — stale-binary false confidence.** Parity test only ran `make` if
   the binary was absent. Fix: always `make` (incremental) in `beforeAll`.
3. **MINOR — untested `H==0` branches.** Added vectors `k=order-1` (forces
   p==-G → infinity branch) and `k=order+1` as literal ≥order bytes (forces
   p==G → doubling branch, and the ≥order path). Both match bb.js. Parity
   suite now 4 tests / 528 expect.

What I did NOT change: the algorithm stays double-and-add-always (correct +
validated). The CT improvement is deliberately deferred, not papered over.

## Deferred to later phases

- `gk_fq_from_bytes_wide_be` (SHA-512 → Grumpkin scalar) — Phase 6 consumer.
- Fixed-base comb perf optimization — only if real-hardware benchmark demands.
- Device-toolchain build wiring (Makefile/CMake in `ledger-app/`) — Phase 6,
  when a handler first calls into the grumpkin module.
