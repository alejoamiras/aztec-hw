/**
 * BN254 Fr field parameters for the Montgomery 4×u64 backend.
 * Generated alongside constants.c; do not edit by hand.
 */
#pragma once

#include "fr.h"

/* p (the BN254 scalar field modulus), little-endian 64-bit limbs. */
extern const fr_t AZ_FR_P;

/* R² mod p, used to convert into Montgomery form via one Montgomery mul. */
extern const fr_t AZ_FR_R2;

/* mu = -p^{-1} mod 2^64. Helper for CIOS reduction. */
extern const uint64_t AZ_FR_MU;
