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
#define THRESHOLD 5.0      /* |t| above this ⇒ leak (dudect uses ~4.5) */

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
  uint8_t fixed[32];
  memset(fixed, 0, 32);
  fixed[31] = 1; /* scalar = 1 */
  uint8_t ox[32], oy[32];

  /* Warm caches / branch predictors. */
  for (int i = 0; i < 2000; i++) grumpkin_scalar_mul_generator(ox, oy, fixed);

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
      memcpy(scalar, fixed, 32);
    } else {
      for (int j = 0; j < 32; j++) scalar[j] = (uint8_t)rand();
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
  long k0, k1;
  cropped_stats(t_fix, n_fix, &m0, &v0, &k0);
  cropped_stats(t_rnd, n_rnd, &m1, &v1, &k1);
  double t = (m0 - m1) / sqrt(v0 / (double)k0 + v1 / (double)k1);

  printf("dudect grumpkin_scalar_mul_generator:\n");
  printf("  FIX(k=1): n=%ld mean=%.1f ns   RND: n=%ld mean=%.1f ns\n", k0, m0, k1, m1);
  printf("  Welch t = %.2f   (threshold %.1f)\n", t, THRESHOLD);
  free(t_fix);
  free(t_rnd);

  if (fabs(t) > THRESHOLD) {
    printf("  RESULT: LEAK DETECTED — secret-dependent timing (NOT constant-time)\n");
    return 1;
  }
  printf("  RESULT: PASS — no secret-dependent timing above threshold\n");
  return 0;
}
