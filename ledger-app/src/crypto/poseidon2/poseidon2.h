/**
 * Poseidon2 over BN254 Fr — public API for the Aztec Ledger app (L4).
 *
 * Algorithm pinned to barretenberg commit `2770bcb82d40323060c2f9c71aaf293b640efbef`:
 *   - `cpp/src/barretenberg/crypto/poseidon2/poseidon2_permutation.hpp`
 *   - `cpp/src/barretenberg/crypto/poseidon2/poseidon2_params.hpp`
 *   - `cpp/src/barretenberg/crypto/poseidon2/sponge/sponge.hpp`
 *
 * Field arithmetic: per the L4 plan (codex xhigh `019e64f4-9fd1-7902-8cf0-a8231d61f790`)
 * use BOLOS bignum primitives (`<ox_bn.h>` / `<cx.h>`) where available. The
 * Poseidon path operates only on PUBLIC manifest data, so timing leakage in
 * Fr arithmetic does not expose the signing key — same audit bar as the L2
 * ECDSA path, with no scalar blinding required.
 *
 * Invariants (assert at init):
 *   - state size `t = 4`
 *   - S-box `x^5`
 *   - 4 leading full rounds + 56 partial rounds + 4 trailing full rounds
 *   - Sponge IV = `(input_len << 64)` — `sponge/sponge.hpp:60`
 *   - `poseidon2HashWithSeparator` prepends the separator as the FIRST field
 *
 * Status: HEADER + PLACEHOLDER. Implementation lands with L4.1 (next session).
 * Vectors at `ledger-app/tests/golden_vectors/l4_outer_hashes.json` are the
 * immutable parity reference — every output must match byte-for-byte.
 */

#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#define AZ_FR_BYTES 32
#define AZ_POSEIDON2_T 4
#define AZ_POSEIDON2_ROUNDS_F 8
#define AZ_POSEIDON2_ROUNDS_P 56

/**
 * Hash an array of BN254 Fr elements, each as a 32-byte BE buffer.
 *
 * @param[in]  fields    Pointer to `count` × 32B contiguous BE Fr inputs.
 * @param[in]  count     Number of input fields. Must be ≥ 0.
 * @param[out] out       32B BE Fr buffer for the hash.
 * @return 0 on success, negative on Fr arithmetic failure.
 */
int az_poseidon2_hash(const uint8_t *fields, size_t count, uint8_t out[AZ_FR_BYTES]);

/**
 * Hash with domain separator — `poseidon2HashWithSeparator([separator, ...fields])`.
 * The separator is prepended as the FIRST field (32B BE), then `fields[0..count]`.
 *
 * Matches `yarn-project/foundation/src/crypto/poseidon/index.ts:poseidon2HashWithSeparator`.
 *
 * @param[in]  fields    Pointer to `count` × 32B BE Fr inputs.
 * @param[in]  count     Number of input fields (excluding separator).
 * @param[in]  separator Domain separator (encoded as Fr internally).
 * @param[out] out       32B BE Fr buffer for the hash.
 * @return 0 on success, negative on Fr arithmetic failure.
 */
int az_poseidon2_hash_with_separator(const uint8_t *fields,
                                     size_t count,
                                     uint32_t separator,
                                     uint8_t out[AZ_FR_BYTES]);
