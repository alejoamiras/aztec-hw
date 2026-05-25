#pragma once

#include <stdbool.h>

#include "buffer.h"

/**
 * Handler for SIGN_OUTER_HASH (L2 K1 path).
 *
 * APDU body layout:
 *   uint8_t  path_len;
 *   uint32_t path[path_len];
 *   uint8_t  outer_hash[32];      // BE encoding of the Aztec Fr scalar
 *
 * Device side:
 *   1. Derives the K1 signing key for `path`.
 *   2. Computes `digest = sha256(outer_hash[32])` — see plan §2.
 *   3. Calls `bip32_derive_ecdsa_sign_rs_hash_256(CX_CURVE_256K1, ..., CX_RND_RFC6979 | CX_LAST, CX_SHA256, digest, 32, r, s, &info)`.
 *   4. Normalizes to low-S (BOLOS does NOT guarantee low-S — final critique §10).
 *   5. Duplicates r/s byte-equality check before returning (fault-injection defense).
 *
 * Response:
 *   uint8_t r[32];
 *   uint8_t s[32];
 *
 * Phase A internal/research-only — blind-sign banner mandatory on confirmation screen.
 */
int handler_sign_outer_hash(buffer_t *cdata);

/** Called by the NBGL approval callback once the user confirms. */
int sign_outer_hash_after_approval(void);

/** Called by the NBGL approval callback if the user rejects. */
int sign_outer_hash_rejected(void);
