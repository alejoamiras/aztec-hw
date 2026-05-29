/**
 * Grumpkin EC point arithmetic — Jacobian coordinates over the BASE field
 * (= poseidon2 `fr_t` = BN254 scalar field 0x...f0000001). See point.h for
 * the field-assignment rationale.
 *
 * Formulas from the Explicit-Formulas Database (hyperelliptic.org/EFD):
 *   - doubling:  dbl-2009-l  (short Weierstrass, a = 0)
 *   - mixed add: madd-2007-bl (Jacobian + affine)
 * Both are the standard a=0 variants; Grumpkin has a = 0 (grumpkin.hpp:31).
 */
#include "point.h"

#include <string.h>

#include "../poseidon2/fr_params.h" /* AZ_FR_P — for the Fermat inverse exponent */

/* ---- small field helpers built on the poseidon2 fr_t primitives -------- */

static bool fr_is_zero(const fr_t *a) {
  return a->limbs[0] == 0 && a->limbs[1] == 0 && a->limbs[2] == 0 && a->limbs[3] == 0;
}

static void fr_one(fr_t *out) {
  fr_from_u64(out, 1);
}

/* out = a^(p-2) mod p (Fermat modular inverse). Left-to-right square-and-multiply
 * over the exponent (AZ_FR_P − 2). Only called once per scalar mult (to_affine),
 * so the cost (~256 sqr + ~Hamming-weight muls) is acceptable. */
static void fr_inverse(fr_t *out, const fr_t *a) {
  /* exponent e = p − 2. p.limbs[0] = 0x43e1f593f0000001, so subtracting 2
   * stays within limb 0 (no borrow): 0x...0001 − 2 = 0x...efffffff. */
  uint64_t e[4];
  for (int i = 0; i < 4; i++) e[i] = AZ_FR_P.limbs[i];
  e[0] -= 2;

  fr_t result;
  fr_one(&result);
  fr_t base;
  fr_set(&base, a);

  for (int limb = 3; limb >= 0; limb--) {
    for (int bit = 63; bit >= 0; bit--) {
      fr_sqr(&result, &result);
      if ((e[limb] >> bit) & 1ULL) {
        fr_mul(&result, &result, &base);
      }
    }
  }
  fr_set(out, &result);
  /* M8 P7.0: base = a = the (secret-derived) Z coordinate; result accumulates a
   * function of it. Scrub both before return. */
  grumpkin_secure_wipe(&result, sizeof(result));
  grumpkin_secure_wipe(&base, sizeof(base));
}

/* ---- point operations -------------------------------------------------- */

void grumpkin_point_set_infinity(grumpkin_point_t *p) {
  fr_zero(&p->x);
  fr_zero(&p->y);
  fr_zero(&p->z);
}

bool grumpkin_point_is_infinity(const grumpkin_point_t *p) {
  return fr_is_zero(&p->z);
}

void grumpkin_point_cmov(grumpkin_point_t *p, const grumpkin_point_t *src, uint8_t flag) {
  /* flag ∈ {0,1}. mask = 0x000...0 (keep p) or 0xfff...f (take src). */
  uint64_t mask = (uint64_t)0 - (uint64_t)(flag & 1);
  for (int i = 0; i < 4; i++) {
    p->x.limbs[i] = (p->x.limbs[i] & ~mask) | (src->x.limbs[i] & mask);
    p->y.limbs[i] = (p->y.limbs[i] & ~mask) | (src->y.limbs[i] & mask);
    p->z.limbs[i] = (p->z.limbs[i] & ~mask) | (src->z.limbs[i] & mask);
  }
}

void grumpkin_point_double(grumpkin_point_t *out, const grumpkin_point_t *p) {
  if (grumpkin_point_is_infinity(p) || fr_is_zero(&p->y)) {
    /* Grumpkin has prime order ⇒ no finite order-2 points (Y never 0 for a
     * finite point), but guard anyway: 2·O = O, and 2·(Y=0 point) = O. */
    grumpkin_point_set_infinity(out);
    return;
  }

  fr_t A, B, C, D, E, F, X3, Y3, Z3, t0, t1;

  fr_sqr(&A, &p->x);  /* A = X1²            */
  fr_sqr(&B, &p->y);  /* B = Y1²            */
  fr_sqr(&C, &B);     /* C = B² = Y1⁴       */

  /* D = 2·((X1+B)² − A − C) = 4·X1·Y1²     */
  fr_add(&t0, &p->x, &B);
  fr_sqr(&t0, &t0);
  fr_sub(&t0, &t0, &A);
  fr_sub(&t0, &t0, &C);
  fr_add(&D, &t0, &t0);

  /* E = 3·A                                 */
  fr_add(&E, &A, &A);
  fr_add(&E, &E, &A);

  fr_sqr(&F, &E); /* F = E²                  */

  /* X3 = F − 2·D                            */
  fr_add(&t0, &D, &D);
  fr_sub(&X3, &F, &t0);

  /* Y3 = E·(D − X3) − 8·C                   */
  fr_sub(&t0, &D, &X3);
  fr_mul(&t0, &E, &t0);
  fr_add(&t1, &C, &C);
  fr_add(&t1, &t1, &t1);
  fr_add(&t1, &t1, &t1);
  fr_sub(&Y3, &t0, &t1);

  /* Z3 = 2·Y1·Z1                            */
  fr_mul(&t0, &p->y, &p->z);
  fr_add(&Z3, &t0, &t0);

  fr_set(&out->x, &X3);
  fr_set(&out->y, &Y3);
  fr_set(&out->z, &Z3);

  /* M8 P7.0: scrub the secret-derived doubling temporaries. */
  grumpkin_secure_wipe(&A, sizeof(A));
  grumpkin_secure_wipe(&B, sizeof(B));
  grumpkin_secure_wipe(&C, sizeof(C));
  grumpkin_secure_wipe(&D, sizeof(D));
  grumpkin_secure_wipe(&E, sizeof(E));
  grumpkin_secure_wipe(&F, sizeof(F));
  grumpkin_secure_wipe(&X3, sizeof(X3));
  grumpkin_secure_wipe(&Y3, sizeof(Y3));
  grumpkin_secure_wipe(&Z3, sizeof(Z3));
  grumpkin_secure_wipe(&t0, sizeof(t0));
  grumpkin_secure_wipe(&t1, sizeof(t1));
}

void grumpkin_point_add_affine(grumpkin_point_t *out, const grumpkin_point_t *p, const fr_t *qx,
                               const fr_t *qy) {
  if (grumpkin_point_is_infinity(p)) {
    fr_set(&out->x, qx);
    fr_set(&out->y, qy);
    fr_one(&out->z);
    return;
  }

  fr_t Z1Z1, U2, S2, H, HH, I, J, r, V, X3, Y3, Z3, t0, t1;

  fr_sqr(&Z1Z1, &p->z);      /* Z1²              */
  fr_mul(&U2, qx, &Z1Z1);    /* U2 = X2·Z1²      */
  fr_mul(&t0, &p->z, &Z1Z1); /* Z1³              */
  fr_mul(&S2, qy, &t0);      /* S2 = Y2·Z1³      */

  fr_sub(&H, &U2, &p->x); /* H = U2 − X1      */
  fr_sub(&r, &S2, &p->y); /* (S2 − Y1)        */

  if (fr_is_zero(&H)) {
    /* x-coordinates equal. */
    if (fr_is_zero(&r)) {
      /* p == Q → doubling. */
      grumpkin_point_double(out, p);
    } else {
      /* p == −Q → infinity. */
      grumpkin_point_set_infinity(out);
    }
    /* M8 P7.0: scrub the temporaries live on this early-return path. */
    grumpkin_secure_wipe(&Z1Z1, sizeof(Z1Z1));
    grumpkin_secure_wipe(&U2, sizeof(U2));
    grumpkin_secure_wipe(&S2, sizeof(S2));
    grumpkin_secure_wipe(&H, sizeof(H));
    grumpkin_secure_wipe(&r, sizeof(r));
    grumpkin_secure_wipe(&t0, sizeof(t0));
    return;
  }

  fr_add(&r, &r, &r); /* r = 2·(S2 − Y1)  */

  fr_sqr(&HH, &H);       /* HH = H²          */
  fr_add(&I, &HH, &HH);  /* 2·HH             */
  fr_add(&I, &I, &I);    /* I = 4·HH         */
  fr_mul(&J, &H, &I);    /* J = H·I          */
  fr_mul(&V, &p->x, &I); /* V = X1·I         */

  /* X3 = r² − J − 2·V */
  fr_sqr(&X3, &r);
  fr_sub(&X3, &X3, &J);
  fr_add(&t0, &V, &V);
  fr_sub(&X3, &X3, &t0);

  /* Y3 = r·(V − X3) − 2·Y1·J */
  fr_sub(&t0, &V, &X3);
  fr_mul(&t0, &r, &t0);
  fr_mul(&t1, &p->y, &J);
  fr_add(&t1, &t1, &t1);
  fr_sub(&Y3, &t0, &t1);

  /* Z3 = (Z1 + H)² − Z1Z1 − HH */
  fr_add(&t0, &p->z, &H);
  fr_sqr(&t0, &t0);
  fr_sub(&t0, &t0, &Z1Z1);
  fr_sub(&Z3, &t0, &HH);

  fr_set(&out->x, &X3);
  fr_set(&out->y, &Y3);
  fr_set(&out->z, &Z3);

  /* M8 P7.0: scrub the secret-derived mixed-add temporaries. */
  grumpkin_secure_wipe(&Z1Z1, sizeof(Z1Z1));
  grumpkin_secure_wipe(&U2, sizeof(U2));
  grumpkin_secure_wipe(&S2, sizeof(S2));
  grumpkin_secure_wipe(&H, sizeof(H));
  grumpkin_secure_wipe(&HH, sizeof(HH));
  grumpkin_secure_wipe(&I, sizeof(I));
  grumpkin_secure_wipe(&J, sizeof(J));
  grumpkin_secure_wipe(&r, sizeof(r));
  grumpkin_secure_wipe(&V, sizeof(V));
  grumpkin_secure_wipe(&X3, sizeof(X3));
  grumpkin_secure_wipe(&Y3, sizeof(Y3));
  grumpkin_secure_wipe(&Z3, sizeof(Z3));
  grumpkin_secure_wipe(&t0, sizeof(t0));
  grumpkin_secure_wipe(&t1, sizeof(t1));
}

bool grumpkin_point_to_affine_be(uint8_t out_x[32], uint8_t out_y[32], const grumpkin_point_t *p) {
  if (grumpkin_point_is_infinity(p)) {
    memset(out_x, 0, 32);
    memset(out_y, 0, 32);
    return false;
  }
  fr_t zinv, zinv2, zinv3, x, y;
  fr_inverse(&zinv, &p->z);
  fr_sqr(&zinv2, &zinv);
  fr_mul(&zinv3, &zinv2, &zinv);
  fr_mul(&x, &p->x, &zinv2);
  fr_mul(&y, &p->y, &zinv3);
  fr_to_bytes_be(out_x, &x);
  fr_to_bytes_be(out_y, &y);
  /* M8 P7.0: zinv* are functions of the secret-derived Z; scrub them. (x,y are
   * the public output coords, written to out_x/out_y.) */
  grumpkin_secure_wipe(&zinv, sizeof(zinv));
  grumpkin_secure_wipe(&zinv2, sizeof(zinv2));
  grumpkin_secure_wipe(&zinv3, sizeof(zinv3));
  return true;
}

bool grumpkin_affine_on_curve(const fr_t *x, const fr_t *y) {
  fr_t y2, x3, b, zero;
  fr_sqr(&y2, y);
  fr_sqr(&x3, x);
  fr_mul(&x3, &x3, x); /* x³ */
  /* b = −17 mod Fr */
  fr_from_u64(&b, 17);
  fr_zero(&zero);
  fr_sub(&b, &zero, &b);
  fr_add(&x3, &x3, &b); /* x³ − 17 */
  return fr_eq(&y2, &x3);
}
