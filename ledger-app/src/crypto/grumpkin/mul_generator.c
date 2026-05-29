/**
 * Grumpkin fixed-base scalar mult [k]·G — double-and-add-always.
 *
 * Correctness-first algorithm choice (M8 PoC): the simplest construction that
 * is (a) obviously correct and (b) constant-time at the bit-processing layer.
 * For every one of the 256 scalar bits we ALWAYS perform one doubling and one
 * addition, then constant-time-select whether to keep the addition result.
 * No data-dependent loop bounds, no secret-dependent table indexing.
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

bool grumpkin_scalar_mul_generator(uint8_t out_x[32], uint8_t out_y[32],
                                   const uint8_t scalar_be[32]) {
  fr_t gx, gy;
  /* Generator coords are canonical (< Fr) by construction, so from_bytes_be
   * always succeeds; ignore the return. */
  (void)fr_from_bytes_be(&gx, GRUMPKIN_G_X_BE);
  (void)fr_from_bytes_be(&gy, GRUMPKIN_G_Y_BE);

  grumpkin_point_t acc;
  grumpkin_point_set_infinity(&acc);

  grumpkin_point_t tmp;
  for (int byte = 0; byte < 32; byte++) {
    for (int bit = 7; bit >= 0; bit--) {
      /* acc = 2·acc */
      grumpkin_point_double(&acc, &acc);
      /* tmp = acc + G */
      grumpkin_point_add_affine(&tmp, &acc, &gx, &gy);
      /* acc = bit ? tmp : acc  (constant-time) */
      uint8_t b = (uint8_t)((scalar_be[byte] >> bit) & 1u);
      grumpkin_point_cmov(&acc, &tmp, b);
    }
  }

  return grumpkin_point_to_affine_be(out_x, out_y, &acc);
}
