/**
 * BN254 BASE field Montgomery arithmetic — CIOS, 4×u64 limbs.
 *
 * Algorithm cloned from `crypto/poseidon2/fr.c` (same CIOS pattern, identical
 * shape) but with Fq params from `fq_params.{c,h}`. **Codex final-audit
 * BLOCKER #1 fix:** this file is NOT a typedef alias for `fr.c` — the prime
 * is different (see `fq.h` header).
 *
 * Reference: Koç, Acar & Kaliski (1996), "Analyzing and Comparing Montgomery
 * Multiplication Algorithms," IEEE Micro 16(3):26-33, fig. 2.
 *
 * Portability + threat model: same as `fr.c`. The 64×64 → 128 multiply uses
 * a 4×(32×32 → 64) decomposition for BOLOS clang compatibility (no native
 * `__uint128_t` on the 32-bit ARM target).
 */
#include "fq.h"
#include "fq_params.h"

#include <string.h>

/* Schoolbook 64×64 → 128 multiplication via 4×(32×32 → 64). */
static void mul64(uint64_t a, uint64_t b, uint64_t *hi, uint64_t *lo) {
  uint64_t al = a & 0xffffffffULL;
  uint64_t ah = a >> 32;
  uint64_t bl = b & 0xffffffffULL;
  uint64_t bh = b >> 32;

  uint64_t p00 = al * bl;
  uint64_t p01 = al * bh;
  uint64_t p10 = ah * bl;
  uint64_t p11 = ah * bh;

  uint64_t mid = p01 + p10;
  uint64_t mid_overflow = (mid < p01) ? 1ULL : 0;

  uint64_t lo_v = p00 + (mid << 32);
  uint64_t lo_carry = (lo_v < p00) ? 1ULL : 0;

  uint64_t hi_v = p11 + (mid >> 32) + (mid_overflow << 32) + lo_carry;

  *lo = lo_v;
  *hi = hi_v;
}

/* (carry_out, out) = a*b + c + carry_in. */
static void muladd(uint64_t a, uint64_t b, uint64_t c, uint64_t carry_in, uint64_t *out,
                   uint64_t *carry_out) {
  uint64_t hi, lo;
  mul64(a, b, &hi, &lo);

  uint64_t s = lo + c;
  uint64_t k1 = (s < c) ? 1ULL : 0;
  uint64_t s2 = s + carry_in;
  uint64_t k2 = (s2 < carry_in) ? 1ULL : 0;

  *out = s2;
  *carry_out = hi + k1 + k2;
}

void gk_fq_zero(gk_fq_t *out) {
  out->limbs[0] = 0;
  out->limbs[1] = 0;
  out->limbs[2] = 0;
  out->limbs[3] = 0;
}

void gk_fq_set(gk_fq_t *out, const gk_fq_t *a) {
  out->limbs[0] = a->limbs[0];
  out->limbs[1] = a->limbs[1];
  out->limbs[2] = a->limbs[2];
  out->limbs[3] = a->limbs[3];
}

bool gk_fq_eq(const gk_fq_t *a, const gk_fq_t *b) {
  return a->limbs[0] == b->limbs[0] && a->limbs[1] == b->limbs[1] &&
         a->limbs[2] == b->limbs[2] && a->limbs[3] == b->limbs[3];
}

/* Compare a vs AZ_FQ_P. <0 / 0 / >0 if a < / = / > p. */
static int gk_fq_cmp_p(const gk_fq_t *a) {
  for (int i = AZ_FQ_NUM_LIMBS - 1; i >= 0; i--) {
    if (a->limbs[i] < AZ_FQ_P.limbs[i]) return -1;
    if (a->limbs[i] > AZ_FQ_P.limbs[i]) return 1;
  }
  return 0;
}

void gk_fq_add(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b) {
  uint64_t r[AZ_FQ_NUM_LIMBS];
  uint64_t carry = 0;
  for (int i = 0; i < AZ_FQ_NUM_LIMBS; i++) {
    uint64_t s = a->limbs[i] + b->limbs[i];
    uint64_t c1 = (s < a->limbs[i]) ? 1ULL : 0;
    uint64_t s2 = s + carry;
    uint64_t c2 = (s2 < carry) ? 1ULL : 0;
    r[i] = s2;
    carry = c1 + c2;
  }
  bool ge_p = (carry != 0);
  if (!ge_p) {
    for (int i = AZ_FQ_NUM_LIMBS - 1; i >= 0; i--) {
      if (r[i] < AZ_FQ_P.limbs[i]) {
        ge_p = false;
        break;
      }
      if (r[i] > AZ_FQ_P.limbs[i]) {
        ge_p = true;
        break;
      }
      if (i == 0) ge_p = true;
    }
  }
  if (ge_p) {
    uint64_t borrow = 0;
    for (int i = 0; i < AZ_FQ_NUM_LIMBS; i++) {
      uint64_t d = r[i] - AZ_FQ_P.limbs[i];
      uint64_t b1 = (r[i] < AZ_FQ_P.limbs[i]) ? 1ULL : 0;
      uint64_t d2 = d - borrow;
      uint64_t b2 = (d < borrow) ? 1ULL : 0;
      r[i] = d2;
      borrow = b1 + b2;
    }
  }
  memcpy(out->limbs, r, sizeof(r));
}

void gk_fq_sub(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b) {
  uint64_t r[AZ_FQ_NUM_LIMBS];
  uint64_t borrow = 0;
  for (int i = 0; i < AZ_FQ_NUM_LIMBS; i++) {
    uint64_t d = a->limbs[i] - b->limbs[i];
    uint64_t b1 = (a->limbs[i] < b->limbs[i]) ? 1ULL : 0;
    uint64_t d2 = d - borrow;
    uint64_t b2 = (d < borrow) ? 1ULL : 0;
    r[i] = d2;
    borrow = b1 + b2;
  }
  if (borrow) {
    uint64_t carry = 0;
    for (int i = 0; i < AZ_FQ_NUM_LIMBS; i++) {
      uint64_t s = r[i] + AZ_FQ_P.limbs[i];
      uint64_t c1 = (s < r[i]) ? 1ULL : 0;
      uint64_t s2 = s + carry;
      uint64_t c2 = (s2 < carry) ? 1ULL : 0;
      r[i] = s2;
      carry = c1 + c2;
    }
  }
  memcpy(out->limbs, r, sizeof(r));
}

void gk_fq_mul(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b) {
  uint64_t t[AZ_FQ_NUM_LIMBS + 2] = {0};

  for (int i = 0; i < AZ_FQ_NUM_LIMBS; i++) {
    /* Phase 1: t += a · b[i]. */
    uint64_t carry = 0;
    for (int j = 0; j < AZ_FQ_NUM_LIMBS; j++) {
      muladd(a->limbs[j], b->limbs[i], t[j], carry, &t[j], &carry);
    }
    uint64_t s = t[AZ_FQ_NUM_LIMBS] + carry;
    uint64_t k = (s < carry) ? 1ULL : 0;
    t[AZ_FQ_NUM_LIMBS] = s;
    t[AZ_FQ_NUM_LIMBS + 1] = k;

    /* Phase 2: m makes t[0] zero modulo 2^64. */
    uint64_t m = t[0] * AZ_FQ_MU;

    uint64_t hi0, lo0;
    mul64(m, AZ_FQ_P.limbs[0], &hi0, &lo0);
    uint64_t s0 = lo0 + t[0];
    uint64_t c0_extra = (s0 < t[0]) ? 1ULL : 0;
    carry = hi0 + c0_extra;

    for (int j = 1; j < AZ_FQ_NUM_LIMBS; j++) {
      muladd(m, AZ_FQ_P.limbs[j], t[j], carry, &t[j - 1], &carry);
    }
    uint64_t s1 = t[AZ_FQ_NUM_LIMBS] + carry;
    uint64_t k1 = (s1 < carry) ? 1ULL : 0;
    t[AZ_FQ_NUM_LIMBS - 1] = s1;
    uint64_t s2 = t[AZ_FQ_NUM_LIMBS + 1] + k1;
    t[AZ_FQ_NUM_LIMBS] = s2;
    t[AZ_FQ_NUM_LIMBS + 1] = 0;
  }

  gk_fq_t r;
  for (int i = 0; i < AZ_FQ_NUM_LIMBS; i++) r.limbs[i] = t[i];

  bool ge_p = (t[AZ_FQ_NUM_LIMBS] != 0);
  if (!ge_p) {
    for (int i = AZ_FQ_NUM_LIMBS - 1; i >= 0; i--) {
      if (r.limbs[i] < AZ_FQ_P.limbs[i]) {
        ge_p = false;
        break;
      }
      if (r.limbs[i] > AZ_FQ_P.limbs[i]) {
        ge_p = true;
        break;
      }
      if (i == 0) ge_p = true;
    }
  }
  if (ge_p) {
    uint64_t borrow = 0;
    for (int i = 0; i < AZ_FQ_NUM_LIMBS; i++) {
      uint64_t d = r.limbs[i] - AZ_FQ_P.limbs[i];
      uint64_t b1 = (r.limbs[i] < AZ_FQ_P.limbs[i]) ? 1ULL : 0;
      uint64_t d2 = d - borrow;
      uint64_t b2 = (d < borrow) ? 1ULL : 0;
      r.limbs[i] = d2;
      borrow = b1 + b2;
    }
  }
  gk_fq_set(out, &r);
}

void gk_fq_sqr(gk_fq_t *out, const gk_fq_t *a) {
  /* Dedicated squaring saves ~25% mul64 ops; deferred to Phase 5 perf-tuning
   * if real-hardware benchmark shows it matters. */
  gk_fq_mul(out, a, a);
}

void gk_fq_from_bytes_wide_be(gk_fq_t *out, const uint8_t bytes[64]) {
  /* Horner over the 64 input bytes, MSB first (same construction as poseidon2
   * fr_from_bytes_wide_be, but mod the Grumpkin scalar order). Each step keeps
   * acc < p, so there is no CIOS input-range subtlety. Called once per viewing
   * scalar (4x per deploy verify); simplicity over the R^2-folding variant. */
  gk_fq_t acc, c256, term;
  gk_fq_zero(&acc);
  gk_fq_from_u64(&c256, 256);
  for (int i = 0; i < 64; i++) {
    gk_fq_mul(&acc, &acc, &c256);
    gk_fq_from_u64(&term, bytes[i]);
    gk_fq_add(&acc, &acc, &term);
  }
  gk_fq_set(out, &acc);
}

bool gk_fq_from_bytes_be(gk_fq_t *out, const uint8_t bytes[AZ_FQ_BYTE_LEN]) {
  gk_fq_t tmp;
  for (int i = 0; i < AZ_FQ_NUM_LIMBS; i++) {
    uint64_t limb = 0;
    for (int b = 0; b < 8; b++) {
      limb = (limb << 8) | bytes[(AZ_FQ_NUM_LIMBS - 1 - i) * 8 + b];
    }
    tmp.limbs[i] = limb;
  }
  if (gk_fq_cmp_p(&tmp) >= 0) {
    return false;
  }
  /* tmp · R² · R⁻¹ = tmp · R → Montgomery form. */
  gk_fq_mul(out, &tmp, &AZ_FQ_R2);
  return true;
}

void gk_fq_from_u64(gk_fq_t *out, uint64_t v) {
  gk_fq_t tmp = {{v, 0, 0, 0}};
  gk_fq_mul(out, &tmp, &AZ_FQ_R2);
}

void gk_fq_to_bytes_be(uint8_t bytes[AZ_FQ_BYTE_LEN], const gk_fq_t *a) {
  /* Mont-mul by literal 1 (normal form) → leave Montgomery. */
  gk_fq_t one_normal = {{1, 0, 0, 0}};
  gk_fq_t normal;
  gk_fq_mul(&normal, a, &one_normal);

  for (int i = 0; i < AZ_FQ_NUM_LIMBS; i++) {
    uint64_t limb = normal.limbs[AZ_FQ_NUM_LIMBS - 1 - i];
    for (int b = 0; b < 8; b++) {
      bytes[i * 8 + b] = (uint8_t)(limb >> (56 - b * 8));
    }
  }
}
