/**
 * BN254 Fr field arithmetic — Montgomery 4×u64 backend (portable C99).
 *
 * Used by Poseidon2 to recompute the Aztec outer_hash on-device. This is the
 * scalar field of the BN254 curve (the same Fr that barretenberg's
 * `bb::fr` operates on); see
 * `aztec-packages/barretenberg/cpp/src/barretenberg/ecc/curves/bn254/fr.hpp`.
 *
 * Convention:
 *   - `fr_t` stores values in Montgomery form (i.e. `x · R mod p`,
 *     R = 2^256). All in-permutation arithmetic stays in this form so
 *     additions are free and multiplications use a single CIOS reduction.
 *   - Conversion from raw 32-byte BE input → Montgomery happens at
 *     boundary calls only (`fr_from_bytes_be`, `fr_from_u64`).
 *   - Conversion back to BE (`fr_to_bytes_be`) is the only place that needs
 *     a multiply-by-1 reduction.
 *
 * Threat model note: Poseidon2 operates on PUBLIC manifest data only. There
 * is no need for constant-time arithmetic on these field elements (the
 * private signing key is never touched by this code path). All Fr functions
 * here are written for clarity, not constant-time guarantees.
 *
 * Same audit bar as the L2 ECDSA path; future work may swap this for the
 * BOLOS bignum primitives (`<ox_bn.h>`) if perf demands.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AZ_FR_LIMB_BITS 64
#define AZ_FR_NUM_LIMBS 4
#define AZ_FR_BYTE_LEN 32

typedef struct {
    uint64_t limbs[AZ_FR_NUM_LIMBS];
} fr_t;

/* Initialize to canonical zero (Montgomery form of 0 is 0). */
void fr_zero(fr_t *out);

/* Copy. */
void fr_set(fr_t *out, const fr_t *a);

/* Equality test (Montgomery form is canonical). */
bool fr_eq(const fr_t *a, const fr_t *b);

/* Load from 32-byte big-endian buffer (input is in NORMAL form). Result is
 * Montgomery form. Fails (returns false) if input >= p. */
bool fr_from_bytes_be(fr_t *out, const uint8_t bytes[AZ_FR_BYTE_LEN]);

/* Store to 32-byte big-endian buffer (output is in NORMAL form). */
void fr_to_bytes_be(uint8_t bytes[AZ_FR_BYTE_LEN], const fr_t *a);

/* Convert a uint64 (normal form) → Montgomery form. Always succeeds. */
void fr_from_u64(fr_t *out, uint64_t v);

/* Modular addition: out = a + b (mod p). Inputs and output are Montgomery. */
void fr_add(fr_t *out, const fr_t *a, const fr_t *b);

/* Modular subtraction: out = a - b (mod p). */
void fr_sub(fr_t *out, const fr_t *a, const fr_t *b);

/* Montgomery multiplication: out = a · b · R^{-1} (mod p). Both inputs
 * Montgomery → output Montgomery. */
void fr_mul(fr_t *out, const fr_t *a, const fr_t *b);

/* Montgomery squaring: out = a^2 · R^{-1} (mod p). */
void fr_sqr(fr_t *out, const fr_t *a);
