/**
 * BN254 BASE field arithmetic — Montgomery 4×u64 backend (portable C99).
 *
 * **The BASE field of BN254 is the SCALAR field of Grumpkin** — Aztec's
 * default ZK curve. The two fields share their first 4 high-bytes but are
 * distinct primes; see `aztec-packages/yarn-project/foundation/src/curves/
 * bn254/field.ts:360-367`. Codex final-audit BLOCKER #1: `gk_fq_t` is
 * NOT a typedef alias for the `fr_t` in `crypto/poseidon2/fr.h` (which
 * encodes the BN254 SCALAR field = Aztec `Fr`). Aliasing would silently
 * misderive every Grumpkin scalar mult on-device.
 *
 *   p_fq = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
 *   p_fr = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
 *           (^ same high-bytes, different prime)
 *
 * Constants in `fq_params.{c,h}` are emitted by
 * `ledger-app/scripts/gen-fq-params.ts`. Algorithm structure is otherwise
 * identical to `crypto/poseidon2/fr.c`; see that file for the CIOS reference.
 *
 * Convention:
 *   - `gk_fq_t` stores values in Montgomery form (`x · R mod p`, R = 2^256).
 *   - Boundary conversions: `gk_fq_from_bytes_be` (BE → Montgomery, fails
 *     if input ≥ p), `gk_fq_to_bytes_be` (Montgomery → BE, normal form).
 *
 * Threat model — DISTINCT from `fr.c`. Grumpkin scalar mult on this field
 * runs over PRIVATE viewing scalars (nhk_m, ivsk_m, ovsk_m, tsk_m in
 * Phase 6). The Phase 3+ scalar mult MUST be constant-time relative to
 * the scalar bits; this field-arith layer is the substrate. The current
 * impl is branch-free for add/sub/mul (mirrors `fr.c`'s structure) but
 * has NOT been audited for power/EM resistance — that's a production-bar
 * concern handed to Phase 9 + post-M8 Donjon engagement (~$40k per opus
 * audit estimate).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AZ_FQ_LIMB_BITS 64
#define AZ_FQ_NUM_LIMBS 4
#define AZ_FQ_BYTE_LEN 32

/** Montgomery-form Grumpkin scalar (= BN254 base field). DISTINCT TYPE from
 * `fr_t` in `crypto/poseidon2/fr.h` — same shape, different modulus. */
typedef struct {
  uint64_t limbs[AZ_FQ_NUM_LIMBS];
} gk_fq_t;

/** Initialize to zero (Montgomery form of 0 is 0). */
void gk_fq_zero(gk_fq_t *out);

/** Secure-wipe a SECRET field element via volatile stores the compiler MUST emit
 * — NOT dead-store-eliminated under -Oz (gk_fq_zero inlines to dead stores that
 * get dropped). Needs no BOLOS os.h, so the host parity oracle still builds.
 * Use for scrubbing secret-derived gk_fq_t (AHW-100); NOT for the zero element. */
void gk_fq_secure_wipe(gk_fq_t *x);

/** Copy. */
void gk_fq_set(gk_fq_t *out, const gk_fq_t *a);

/** Equality (Montgomery form is canonical: same value ↔ same bytes). */
bool gk_fq_eq(const gk_fq_t *a, const gk_fq_t *b);

/** Load from 32-byte big-endian buffer (NORMAL form input). Result is
 * Montgomery. Returns false if input ≥ p. */
bool gk_fq_from_bytes_be(gk_fq_t *out, const uint8_t bytes[AZ_FQ_BYTE_LEN]);

/** Store to 32-byte big-endian buffer (NORMAL form output). */
void gk_fq_to_bytes_be(uint8_t bytes[AZ_FQ_BYTE_LEN], const gk_fq_t *a);

/** uint64 → Montgomery. Always succeeds (u64 ≪ p). */
void gk_fq_from_u64(gk_fq_t *out, uint64_t v);

/** out = a + b (mod p). Inputs/output Montgomery. */
void gk_fq_add(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b);

/** out = a − b (mod p). */
void gk_fq_sub(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b);

/** Montgomery multiplication: out = a · b · R⁻¹ (mod p). Montgomery × Montgomery → Montgomery. */
void gk_fq_mul(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b);

/** Montgomery squaring: out = a² · R⁻¹ (mod p). */
void gk_fq_sqr(gk_fq_t *out, const gk_fq_t *a);

/* Reduce a 64-byte big-endian integer mod p (WIDE reduction). Output is
 * Montgomery form. Used by M8 Phase 6 to map a SHA-512 digest into a Grumpkin
 * SCALAR (`sha512ToGrumpkinScalar`) when deriving the four viewing keys from
 * the master secret. Mirrors poseidon2 `fr_from_bytes_wide_be` but mod the
 * Grumpkin scalar order. Bias <= 2^{-256}; never fails. */
void gk_fq_from_bytes_wide_be(gk_fq_t *out, const uint8_t bytes[64]);
