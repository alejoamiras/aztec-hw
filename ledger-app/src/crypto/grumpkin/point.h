/**
 * Grumpkin elliptic-curve points — Jacobian coordinates over the curve's
 * BASE field.
 *
 * **Field assignment (the make-or-break subtlety).** Grumpkin is the 2-cycle
 * sister of BN254. Its fields are SWAPPED relative to BN254:
 *
 *   - Grumpkin BASE field  (where point coords x,y,Z live, where add/double
 *     arithmetic runs) = BN254 SCALAR field = Aztec `Fr` = 0x...f0000001
 *     = the `fr_t` in `crypto/poseidon2/fr.{c,h}`.   ← THIS FILE USES fr_t.
 *
 *   - Grumpkin SCALAR field (the `k` multiplier in [k]G, the Grumpkin group
 *     order) = BN254 BASE field = Aztec `Fq` = 0x...d87cfd47 = `gk_fq_t` in
 *     `crypto/grumpkin/fq.{c,h}`.   ← the scalar; NOT used for coordinates.
 *
 * Verified two ways: (1) empirically, G=(1, 17631…860) satisfies y²=x³−17
 * only over Fr (0x...f0000001); (2) barretenberg `ecc/curves/grumpkin/
 * grumpkin.hpp:59-60` — `ScalarField = bb::fq`, `BaseField = bb::fr`.
 *
 * Curve: y² = x³ − 17 (short Weierstrass, a = 0, b = −17 over Fr;
 * grumpkin.hpp:31 confirms a = 0, so the a=0 doubling formula is valid).
 *
 * Coordinate convention: Jacobian (X, Y, Z) ↦ affine (X/Z², Y/Z³). Z == 0
 * is the point at infinity.
 *
 * Threat-model note: the `fr_t` arithmetic reused here is documented in
 * `poseidon2/fr.h` as NON-constant-time (final conditional subtract branches
 * on data). The scalar-mult driver (mul_generator.c) is double-and-add-ALWAYS
 * for every bit at-and-after the first set bit, but it is NOT fully
 * constant-time: leading-zero bits of the scalar hit the infinity fast-paths
 * in `double`/`add_affine`, leaking the scalar's effective bit-length (codex
 * Phase-3 review MAJOR). Per-limb mul timing and the rare `H==0` edge branches
 * in `grumpkin_point_add_affine` are also data-dependent. ALL of these are
 * accepted PoC limitations — full side-channel resistance (constant-time fr
 * layer + an infinity-free comb + Donjon audit) is Phase 9 / post-M8. This
 * build is NOT side-channel-resistant.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../poseidon2/fr.h"

/**
 * Zero a secret-bearing EC stack temporary. A `volatile` byte loop the compiler
 * may not elide (dead-store elimination can drop a plain `memset`). Used instead
 * of `explicit_bzero` because these sources are ALSO host-compiled
 * (`tests/grumpkin_host`) under `-std=c11 -Werror`, where `explicit_bzero` is
 * not declared by `<string.h>` and would be an implicit-declaration error.
 * Identical behaviour on device and host. (M8 P7.0 — impl-audit `bb56tmdxj`:
 * scrub the scalar-mult/inversion temporaries so no secret-derived value
 * survives the APDU on the stack.)
 */
static inline void grumpkin_secure_wipe(void *p, size_t n) {
  volatile unsigned char *vp = (volatile unsigned char *)p;
  while (n-- > 0) *vp++ = 0;
}

/** Jacobian Grumpkin point over the base field (= poseidon2 `fr_t`). */
typedef struct {
  fr_t x;
  fr_t y;
  fr_t z; /* z == 0 ↔ point at infinity */
} grumpkin_point_t;

/** Set p to the point at infinity (Z = 0). */
void grumpkin_point_set_infinity(grumpkin_point_t *p);

/** True iff p is the point at infinity. */
bool grumpkin_point_is_infinity(const grumpkin_point_t *p);

/** Constant-time conditional move: p = flag ? src : p. `flag` MUST be 0 or 1. */
void grumpkin_point_cmov(grumpkin_point_t *p, const grumpkin_point_t *src, uint8_t flag);

/** out = 2·p (Jacobian doubling, a=0 formula). Handles p = infinity. */
void grumpkin_point_double(grumpkin_point_t *out, const grumpkin_point_t *p);

/**
 * out = p + Q, where Q = (qx, qy) is an affine point on the curve (NOT
 * infinity). Handles all edge cases: p = infinity (→ Q), p = Q (→ doubling),
 * p = −Q (→ infinity). `out` may alias `p`.
 */
void grumpkin_point_add_affine(grumpkin_point_t *out, const grumpkin_point_t *p, const fr_t *qx,
                               const fr_t *qy);

/**
 * Convert p to affine big-endian byte coordinates. For the point at infinity
 * writes (0, 0) and returns false; otherwise writes (x, y) and returns true.
 * Performs ONE field inversion (Fermat) — the only inversion in a scalar mult.
 */
bool grumpkin_point_to_affine_be(uint8_t out_x[32], uint8_t out_y[32], const grumpkin_point_t *p);

/** Affine on-curve test: y² == x³ − 17 (mod Fr). For tests / sanity checks. */
bool grumpkin_affine_on_curve(const fr_t *x, const fr_t *y);
