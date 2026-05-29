/**
 * BN254 Fr Montgomery arithmetic — CIOS, 4×u64 limbs.
 *
 * Portability:
 *   - x86_64 / arm64 host: compiles natively.
 *   - 32-bit ARM (Cortex-M0+/M35P with BOLOS clang): we cannot rely on
 *     `__uint128_t` here (the BOLOS clang headers don't expose it on the
 *     32-bit target). Instead, the 64×64 → 128 product is decomposed into
 *     four 32×32 → 64 multiplications, which the toolchain lowers to
 *     hardware instructions where possible.
 *
 * Reference: Koç, Acar & Kaliski (1996), "Analyzing and Comparing Montgomery
 * Multiplication Algorithms," IEEE Micro 16(3):26-33, fig. 2.
 */
#include "fr.h"
#include "fr_params.h"

#include <string.h>

/* Schoolbook 64×64 → 128 multiplication via 4 × (32×32 → 64) sub-multiplications.
 * Returns (hi64, lo64). */
static void mul64(uint64_t a, uint64_t b, uint64_t *hi, uint64_t *lo) {
    uint64_t al = a & 0xffffffffULL;
    uint64_t ah = a >> 32;
    uint64_t bl = b & 0xffffffffULL;
    uint64_t bh = b >> 32;

    uint64_t p00 = al * bl;
    uint64_t p01 = al * bh;
    uint64_t p10 = ah * bl;
    uint64_t p11 = ah * bh;

    /* "middle" = p01 + p10 (can overflow 64 bits). */
    uint64_t mid = p01 + p10;
    uint64_t mid_overflow = (mid < p01) ? 1ULL : 0; /* one bit of carry */

    /* lo64 = p00 + (mid << 32) */
    uint64_t lo_v = p00 + (mid << 32);
    uint64_t lo_carry = (lo_v < p00) ? 1ULL : 0;

    /* hi64 = p11 + (mid >> 32) + (mid_overflow << 32) + lo_carry */
    uint64_t hi_v = p11 + (mid >> 32) + (mid_overflow << 32) + lo_carry;

    *lo = lo_v;
    *hi = hi_v;
}

/* Compute (carry_out, out) = a*b + c + carry_in (extended-precision add). */
static void muladd(uint64_t a, uint64_t b, uint64_t c, uint64_t carry_in,
                   uint64_t *out, uint64_t *carry_out) {
    uint64_t hi, lo;
    mul64(a, b, &hi, &lo);

    uint64_t s = lo + c;
    uint64_t k1 = (s < c) ? 1ULL : 0;
    uint64_t s2 = s + carry_in;
    uint64_t k2 = (s2 < carry_in) ? 1ULL : 0;

    *out = s2;
    *carry_out = hi + k1 + k2;
}

void fr_zero(fr_t *out) {
    out->limbs[0] = 0;
    out->limbs[1] = 0;
    out->limbs[2] = 0;
    out->limbs[3] = 0;
}

void fr_set(fr_t *out, const fr_t *a) {
    out->limbs[0] = a->limbs[0];
    out->limbs[1] = a->limbs[1];
    out->limbs[2] = a->limbs[2];
    out->limbs[3] = a->limbs[3];
}

bool fr_eq(const fr_t *a, const fr_t *b) {
    return a->limbs[0] == b->limbs[0]
        && a->limbs[1] == b->limbs[1]
        && a->limbs[2] == b->limbs[2]
        && a->limbs[3] == b->limbs[3];
}

/* Compare a vs AZ_FR_P. <0 if a < p, 0 if equal, >0 if a > p. */
static int fr_cmp_p(const fr_t *a) {
    for (int i = AZ_FR_NUM_LIMBS - 1; i >= 0; i--) {
        if (a->limbs[i] < AZ_FR_P.limbs[i]) return -1;
        if (a->limbs[i] > AZ_FR_P.limbs[i]) return 1;
    }
    return 0;
}

void fr_add(fr_t *out, const fr_t *a, const fr_t *b) {
    uint64_t r[AZ_FR_NUM_LIMBS];
    uint64_t carry = 0;
    for (int i = 0; i < AZ_FR_NUM_LIMBS; i++) {
        uint64_t s = a->limbs[i] + b->limbs[i];
        uint64_t c1 = (s < a->limbs[i]) ? 1ULL : 0;
        uint64_t s2 = s + carry;
        uint64_t c2 = (s2 < carry) ? 1ULL : 0;
        r[i] = s2;
        carry = c1 + c2;
    }
    /* Subtract p if final carry set OR r >= p. */
    bool ge_p = (carry != 0);
    if (!ge_p) {
        for (int i = AZ_FR_NUM_LIMBS - 1; i >= 0; i--) {
            if (r[i] < AZ_FR_P.limbs[i]) { ge_p = false; break; }
            if (r[i] > AZ_FR_P.limbs[i]) { ge_p = true; break; }
            if (i == 0) ge_p = true; /* exactly equal → r >= p */
        }
    }
    if (ge_p) {
        uint64_t borrow = 0;
        for (int i = 0; i < AZ_FR_NUM_LIMBS; i++) {
            uint64_t d = r[i] - AZ_FR_P.limbs[i];
            uint64_t b1 = (r[i] < AZ_FR_P.limbs[i]) ? 1ULL : 0;
            uint64_t d2 = d - borrow;
            uint64_t b2 = (d < borrow) ? 1ULL : 0;
            r[i] = d2;
            borrow = b1 + b2;
        }
    }
    memcpy(out->limbs, r, sizeof(r));
}

void fr_sub(fr_t *out, const fr_t *a, const fr_t *b) {
    uint64_t r[AZ_FR_NUM_LIMBS];
    uint64_t borrow = 0;
    for (int i = 0; i < AZ_FR_NUM_LIMBS; i++) {
        uint64_t d = a->limbs[i] - b->limbs[i];
        uint64_t b1 = (a->limbs[i] < b->limbs[i]) ? 1ULL : 0;
        uint64_t d2 = d - borrow;
        uint64_t b2 = (d < borrow) ? 1ULL : 0;
        r[i] = d2;
        borrow = b1 + b2;
    }
    if (borrow) {
        uint64_t carry = 0;
        for (int i = 0; i < AZ_FR_NUM_LIMBS; i++) {
            uint64_t s = r[i] + AZ_FR_P.limbs[i];
            uint64_t c1 = (s < r[i]) ? 1ULL : 0;
            uint64_t s2 = s + carry;
            uint64_t c2 = (s2 < carry) ? 1ULL : 0;
            r[i] = s2;
            carry = c1 + c2;
        }
    }
    memcpy(out->limbs, r, sizeof(r));
}

void fr_mul(fr_t *out, const fr_t *a, const fr_t *b) {
    uint64_t t[AZ_FR_NUM_LIMBS + 2] = {0};

    for (int i = 0; i < AZ_FR_NUM_LIMBS; i++) {
        /* Phase 1: t += a · b[i] */
        uint64_t carry = 0;
        for (int j = 0; j < AZ_FR_NUM_LIMBS; j++) {
            muladd(a->limbs[j], b->limbs[i], t[j], carry, &t[j], &carry);
        }
        /* Fold carry into t[n], capture overflow in t[n+1]. */
        uint64_t s = t[AZ_FR_NUM_LIMBS] + carry;
        uint64_t k = (s < carry) ? 1ULL : 0;
        t[AZ_FR_NUM_LIMBS] = s;
        t[AZ_FR_NUM_LIMBS + 1] = k;

        /* Phase 2: m makes t[0] zero modulo 2^64. */
        uint64_t m = t[0] * AZ_FR_MU; /* low 64 bits */

        /* j = 0: discard low limb (must be 0 by construction). */
        uint64_t hi0, lo0;
        mul64(m, AZ_FR_P.limbs[0], &hi0, &lo0);
        uint64_t s0 = lo0 + t[0];
        uint64_t c0_extra = (s0 < t[0]) ? 1ULL : 0;
        carry = hi0 + c0_extra; /* t[0] gets discarded; carry forwards */

        for (int j = 1; j < AZ_FR_NUM_LIMBS; j++) {
            muladd(m, AZ_FR_P.limbs[j], t[j], carry, &t[j - 1], &carry);
        }
        /* t[n-1] := t[n] + carry; spill to t[n] from t[n+1]. */
        uint64_t s1 = t[AZ_FR_NUM_LIMBS] + carry;
        uint64_t k1 = (s1 < carry) ? 1ULL : 0;
        t[AZ_FR_NUM_LIMBS - 1] = s1;
        uint64_t s2 = t[AZ_FR_NUM_LIMBS + 1] + k1;
        t[AZ_FR_NUM_LIMBS] = s2;
        t[AZ_FR_NUM_LIMBS + 1] = 0; /* one outer carry max */
    }

    /* Final reduction. After 4 iters, result is in t[0..n-1]; t[n] is 0 or 1. */
    fr_t r;
    for (int i = 0; i < AZ_FR_NUM_LIMBS; i++) r.limbs[i] = t[i];

    bool ge_p = (t[AZ_FR_NUM_LIMBS] != 0);
    if (!ge_p) {
        for (int i = AZ_FR_NUM_LIMBS - 1; i >= 0; i--) {
            if (r.limbs[i] < AZ_FR_P.limbs[i]) { ge_p = false; break; }
            if (r.limbs[i] > AZ_FR_P.limbs[i]) { ge_p = true; break; }
            if (i == 0) ge_p = true;
        }
    }
    if (ge_p) {
        uint64_t borrow = 0;
        for (int i = 0; i < AZ_FR_NUM_LIMBS; i++) {
            uint64_t d = r.limbs[i] - AZ_FR_P.limbs[i];
            uint64_t b1 = (r.limbs[i] < AZ_FR_P.limbs[i]) ? 1ULL : 0;
            uint64_t d2 = d - borrow;
            uint64_t b2 = (d < borrow) ? 1ULL : 0;
            r.limbs[i] = d2;
            borrow = b1 + b2;
        }
    }
    fr_set(out, &r);
}

void fr_sqr(fr_t *out, const fr_t *a) {
    /* Plain mul. Dedicated squaring saves ~25% mul64 ops; deferred to perf-tuning
     * if Speculos timing shows it matters. */
    fr_mul(out, a, a);
}

bool fr_from_bytes_be(fr_t *out, const uint8_t bytes[AZ_FR_BYTE_LEN]) {
    fr_t tmp;
    for (int i = 0; i < AZ_FR_NUM_LIMBS; i++) {
        uint64_t limb = 0;
        for (int b = 0; b < 8; b++) {
            limb = (limb << 8) | bytes[(AZ_FR_NUM_LIMBS - 1 - i) * 8 + b];
        }
        tmp.limbs[i] = limb;
    }
    if (fr_cmp_p(&tmp) >= 0) {
        return false;
    }
    /* tmp · R² · R^{-1} = tmp · R = Montgomery form. */
    fr_mul(out, &tmp, &AZ_FR_R2);
    return true;
}

void fr_from_u64(fr_t *out, uint64_t v) {
    fr_t tmp = {{ v, 0, 0, 0 }};
    fr_mul(out, &tmp, &AZ_FR_R2);
}

void fr_from_bytes_wide_be(fr_t *out, const uint8_t bytes[64]) {
    /* Horner over the 64 input bytes, MSB first:
     *   acc = ((... (b0 * 256 + b1) * 256 + b2) ... ) * 256 + b63   (mod p)
     * Each fr_mul / fr_add keeps acc fully reduced (< p), so there is no
     * CIOS input-range subtlety — this is correct for ANY 64-byte input.
     * Cost ~128 fr_mul + 64 fr_add; called once per key derivation, so the
     * simplicity is worth more than the speed of an R²-folding variant. */
    fr_t acc, c256, term;
    fr_zero(&acc);
    fr_from_u64(&c256, 256);
    for (int i = 0; i < 64; i++) {
        fr_mul(&acc, &acc, &c256);
        fr_from_u64(&term, bytes[i]);
        fr_add(&acc, &acc, &term);
    }
    fr_set(out, &acc);
}

void fr_to_bytes_be(uint8_t bytes[AZ_FR_BYTE_LEN], const fr_t *a) {
    /* Mont-mul by {1,0,0,0} = literal "1" in normal form ⇒ leave Montgomery. */
    fr_t one_normal = {{ 1, 0, 0, 0 }};
    fr_t normal;
    fr_mul(&normal, a, &one_normal);

    for (int i = 0; i < AZ_FR_NUM_LIMBS; i++) {
        uint64_t limb = normal.limbs[AZ_FR_NUM_LIMBS - 1 - i];
        for (int b = 0; b < 8; b++) {
            bytes[i * 8 + b] = (uint8_t)(limb >> (56 - b * 8));
        }
    }
}
