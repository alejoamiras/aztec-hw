/**
 * Internal API for Poseidon2 — exposed so the L4 manifest state machine and
 * the host parity tests can drive the permutation and sponge in pieces.
 *
 * NOT included by application code that just wants `az_poseidon2_hash` —
 * use `poseidon2.h` for that.
 */
#pragma once

#include "fr.h"
#include "poseidon2.h"

/* In-place Poseidon2 BN254 permutation (4 lanes). Inputs and outputs in
 * Montgomery form. Exposed for raw parity testing against
 * TEST_VECTOR_INPUT / TEST_VECTOR_OUTPUT from `poseidon2_params.hpp`. */
void az_poseidon2_permutation_inplace(fr_t state[AZ_POSEIDON2_T]);

/* Streaming sponge state. State[3] holds the IV; cache holds up to 3
 * absorbed-but-not-yet-permuted field elements (rate = 3). */
typedef struct {
    fr_t state[AZ_POSEIDON2_T];
    fr_t cache[3];
    uint8_t cache_size; /* 0..3 */
} az_poseidon2_sponge_t;

/**
 * Initialize the sponge. `input_count` is the number of field elements to
 * be absorbed; it sets the domain-separation IV `state[3] = input_count << 64`
 * (matches `sponge/sponge.hpp:60`).
 */
void az_poseidon2_sponge_init(az_poseidon2_sponge_t *s, uint64_t input_count);

/**
 * Absorb one 32-byte BE field element. Returns 0 on success, negative if
 * `bytes` doesn't encode a canonical Fr element (i.e. value >= p).
 */
int az_poseidon2_sponge_absorb_bytes(az_poseidon2_sponge_t *s, const uint8_t bytes[AZ_FR_BYTE_LEN]);

/**
 * Absorb a 64-bit unsigned integer. Convenience for tx_nonce / flags / etc.
 */
void az_poseidon2_sponge_absorb_u64(az_poseidon2_sponge_t *s, uint64_t v);

/**
 * Squeeze a single field element (writes 32-byte BE to `out`).
 */
void az_poseidon2_sponge_squeeze(az_poseidon2_sponge_t *s, uint8_t out[AZ_FR_BYTE_LEN]);
