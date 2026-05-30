/**
 * Grumpkin fixed-base scalar mult [k]·G — double-and-add-always.
 *
 * Correctness-first algorithm choice (M8 PoC): the simplest construction that
 * is obviously correct. For every one of the 256 scalar bits we ALWAYS perform
 * one doubling and one addition, then constant-time-select (bitmask cmov)
 * whether to keep the addition result. No data-dependent loop bounds, no
 * secret-dependent table indexing.
 *
 * **Constant-time caveat (codex Phase-3 review MAJOR).** This is NOT fully
 * constant-time. While `acc` is still the point at infinity — i.e. for every
 * leading-ZERO bit of `k` up to the first set bit — both `grumpkin_point_double`
 * and `grumpkin_point_add_affine` take their infinity fast-path early returns.
 * That makes the per-iteration work (and thus timing) depend on the leading-
 * zero count of `k`, leaking its effective bit-length (a few top bits, on
 * average < 2 bits for uniformly-random ~254-bit scalars). The CONSTANT part is
 * the operation sequence for every bit AT-AND-AFTER the first set bit. Closing
 * this fully (and the rare `H==0` data branches in add_affine) is Phase 9 /
 * production hardening — the same rewrite that introduces the fixed-base comb
 * removes the infinity short-circuits (start the accumulator at a fixed
 * multiple of G and correct at the end). Do not represent this PoC build as
 * side-channel-resistant.
 *
 * Perf: 256 doublings + 256 additions + 1 inversion ≈ a few thousand fr_mul.
 * The plan's fixed-base 4-bit signed-digit comb (precomputed window table)
 * is the ~5× perf optimization, deferred to a post-correctness pass — it only
 * matters once we benchmark on real Nano S+ hardware (Phase 5, deferred). The
 * parity test validates THIS implementation; the comb (if added) must match
 * the same vectors.
 */
#include "mul_generator.h"

#include "g1_generator.h"
#include "point.h"

/* Shared double-and-add-always core: out = [scalar_be]·(bx,by) for an affine
 * base point already parsed into fr_t. Same algorithm + constant-time caveat as
 * documented above. Scrubs the (possibly secret-derived) accumulator + addend. */
static bool mul_affine_core(uint8_t out_x[32], uint8_t out_y[32], const uint8_t scalar_be[32],
                            const fr_t *bx, const fr_t *by) {
  grumpkin_point_t acc;
  grumpkin_point_set_infinity(&acc);

  grumpkin_point_t tmp;
  for (int byte = 0; byte < 32; byte++) {
    for (int bit = 7; bit >= 0; bit--) {
      grumpkin_point_double(&acc, &acc);              /* acc = 2·acc */
      grumpkin_point_add_affine(&tmp, &acc, bx, by);  /* tmp = acc + base */
      uint8_t b = (uint8_t)((scalar_be[byte] >> bit) & 1u);
      grumpkin_point_cmov(&acc, &tmp, b);             /* acc = bit ? tmp : acc */
    }
  }

  bool ok = grumpkin_point_to_affine_be(out_x, out_y, &acc);
  grumpkin_secure_wipe(&acc, sizeof(acc));
  grumpkin_secure_wipe(&tmp, sizeof(tmp));
  return ok;
}

bool grumpkin_scalar_mul_generator(uint8_t out_x[32], uint8_t out_y[32],
                                   const uint8_t scalar_be[32]) {
  fr_t gx, gy;
  /* Generator coords are canonical (< Fr) by construction. */
  (void)fr_from_bytes_be(&gx, GRUMPKIN_G_X_BE);
  (void)fr_from_bytes_be(&gy, GRUMPKIN_G_Y_BE);
  return mul_affine_core(out_x, out_y, scalar_be, &gx, &gy);
}

/* M10 P2: variable-base [scalar]·P for an arbitrary affine base (BE coords).
 * The vehicle for the Pedersen MSM (P3): each term is [input_i]·generator_i.
 * Fails closed if (px,py) is non-canonical or not on the curve. */
bool grumpkin_scalar_mul_affine(uint8_t out_x[32], uint8_t out_y[32], const uint8_t scalar_be[32],
                                const uint8_t px_be[32], const uint8_t py_be[32]) {
  fr_t bx, by;
  if (!fr_from_bytes_be(&bx, px_be)) return false;
  if (!fr_from_bytes_be(&by, py_be)) return false;
  if (!grumpkin_affine_on_curve(&bx, &by)) return false;
  return mul_affine_core(out_x, out_y, scalar_be, &bx, &by);
}
