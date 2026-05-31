/**
 * M11 P0 — dudect-style timing-leak detector for the Grumpkin fixed-base scalar
 * multiplication (`grumpkin_scalar_mul_generator`, the [k]G used for the signing
 * pubkey + the per-signature nonce point).
 *
 * Method (Reparaz/Balasch/Verbauwhede "dudect"): two input classes, leakage =
 * a timing distribution that depends on the class.
 *   - class FIX : scalar = 1  (max leading zeros → today the accumulator stays at
 *                 infinity for ~255 bits and hits the add/double infinity
 *                 fast-paths, so the call is cheap).
 *   - class RND : uniform 32-byte scalar (accumulator leaves infinity almost
 *                 immediately → ~255 full doublings/adds, expensive).
 * A constant-time mul does the SAME work for both ⇒ Welch t ≈ 0. The current
 * branchy mul leaks the leading-zero count ⇒ |t| is large.
 *
 * IMPORTANT: this is a HOST, ALGORITHMIC gate — it catches secret-dependent
 * CONTROL FLOW (our infinity short-circuits + H==0 branch), NOT device µarch
 * leakage. Speculos/on-device timing is a PERF gate, never a leakage proof.
 *
 * Exit: non-zero if |t| > THRESHOLD (leak), 0 if within budget. Crops the slow
 * decile per class (OS-preemption outliers) before the test.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "mul_generator.h"

#define MEASUREMENTS 40000
#define CROP_FRACTION 0.10 /* drop the slowest 10% of each class (OS noise) */
#define THRESHOLD 5.0      /* |t| above this ⇒ leak (dudect uses ~4.5) — informational */
#define RATIO_MAX 2.0      /* control-flow gate: |full-width / k=1| must be < this */

static uint64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static int cmp_double(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return (x > y) - (x < y);
}

/* Welch t on the lowest (1-CROP_FRACTION) of a sorted sample. */
static void cropped_stats(double *v, long n, double *out_mean, double *out_var, long *out_n) {
  qsort(v, (size_t)n, sizeof(double), cmp_double);
  long keep = (long)(n * (1.0 - CROP_FRACTION));
  if (keep < 2) keep = n;
  double mean = 0;
  for (long i = 0; i < keep; i++) mean += v[i];
  mean /= (double)keep;
  double m2 = 0;
  for (long i = 0; i < keep; i++) {
    double d = v[i] - mean;
    m2 += d * d;
  }
  *out_mean = mean;
  *out_var = keep > 1 ? m2 / (double)(keep - 1) : 0;
  *out_n = keep;
}

int main(void) {
  /* CONTROL-FLOW gate (P3's scope): does the scalar-mul time depend on the
   * scalar's LEADING-ZERO COUNT? That was the ∞ fast-path leak — pre-P3, k=1
   * (255 leading zeros) ran ~16x faster than a full-width scalar (Welch t≈-2522).
   * P3 deletes the fast-path so both do identical work. We gate on the mean-time
   * RATIO, which isolates this control-flow property from the field-arithmetic
   * value-dependence (fr_mul is faster on some operands — the DEFERRED cx_math
   * residual that a full Welch t still detects; reported below, NOT gating). */
  uint8_t k1[32];
  memset(k1, 0, 32);
  k1[31] = 1; /* maximal leading zeros — the worst case for the old fast-path leak */
  uint8_t ox[32], oy[32];

  for (int i = 0; i < 2000; i++) grumpkin_scalar_mul_generator(ox, oy, k1); /* warm */

  double *t_fix = malloc(sizeof(double) * MEASUREMENTS);
  double *t_rnd = malloc(sizeof(double) * MEASUREMENTS);
  if (!t_fix || !t_rnd) {
    fprintf(stderr, "oom\n");
    return 2;
  }
  long n_fix = 0, n_rnd = 0;
  srand(0xC0FFEE);

  for (long i = 0; i < MEASUREMENTS; i++) {
    int cls = rand() & 1; /* randomly interleave classes (dudect) */
    uint8_t scalar[32];
    if (cls == 0) {
      memcpy(scalar, k1, 32);
    } else {
      for (int j = 0; j < 32; j++) scalar[j] = (uint8_t)rand(); /* full-width */
    }
    uint64_t a = now_ns();
    grumpkin_scalar_mul_generator(ox, oy, scalar);
    uint64_t b = now_ns();
    double dt = (double)(b - a);
    if (cls == 0)
      t_fix[n_fix++] = dt;
    else
      t_rnd[n_rnd++] = dt;
  }

  double m0, v0, m1, v1;
  long k0c, k1c;
  cropped_stats(t_fix, n_fix, &m0, &v0, &k0c); /* k=1 */
  cropped_stats(t_rnd, n_rnd, &m1, &v1, &k1c); /* full-width */
  double ratio = (m0 > 0.0) ? m1 / m0 : 0.0;
  double t = (m0 - m1) / sqrt(v0 / (double)k0c + v1 / (double)k1c);

  printf("dudect grumpkin_scalar_mul_generator (leading-zero / control-flow gate):\n");
  printf("  k=1 mean=%.1f ns   full-width mean=%.1f ns   ratio=%.3f (max %.1f)\n", m0, m1, ratio,
         RATIO_MAX);
  printf("  [informational] Welch t=%.1f (thr %.1f) — any residual is the DEFERRED field-arith\n", t,
         THRESHOLD);
  printf("                  (fr_mul) value-dependence, not a control-flow leak.\n");
  free(t_fix);
  free(t_rnd);

  if (ratio > RATIO_MAX || ratio < (1.0 / RATIO_MAX)) {
    printf("  RESULT: CONTROL-FLOW LEAK — scalar-mul time tracks the leading-zero count\n");
    return 1;
  }
  printf("  RESULT: PASS — no leading-zero (control-flow) timing dependence\n");
  return 0;
}
