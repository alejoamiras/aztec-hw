#pragma once

/**
 * Aztec/barretenberg Pedersen hash of exactly 3 inputs (M10 P3) — the inner
 * compression of the Schnorr challenge `e = Blake2s(pedersen([R.x,P.x,P.y])||msg)`.
 *
 *   pedersen([v0,v1,v2]) = ( [3]·g_len + Σ_i (v_i != 0 ? [v_i]·g_i : O) ).x
 *
 * with g_len = the "pedersen_hash_length" generator and g0..g2 = the first 3
 * "DEFAULT_DOMAIN_SEPARATOR" generators (see pedersen.c). Mirrors
 * `pedersenHashWithHashIndexNoble` in @aztec/foundation crypto/pedersen.
 *
 * INVARIANT (codex pre-impl review): inputs MUST be canonical Fr encodings
 * (< the poseidon2 fr modulus); fails closed otherwise. The Schnorr path always
 * feeds Grumpkin point coordinates, which are canonical by construction.
 */
#include <stdbool.h>
#include <stdint.h>

/** out_x = pedersen([v0,v1,v2]).x (BE). Returns false on non-canonical input
 *  or a degenerate (infinity) accumulator. */
bool pedersen_hash3(uint8_t out_x[32], const uint8_t v0[32], const uint8_t v1[32],
                    const uint8_t v2[32]);
