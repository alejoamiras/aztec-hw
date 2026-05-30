/**
 * Device-side partial-address recomputation for the DEPLOY_ACCOUNT clear-sign
 * flow (M7 P3). Mirrors the poseidon2 chain in:
 *
 *   - stdlib/src/contract/contract_address.ts
 *   - stdlib/src/hash/hash.ts (computeVarArgsHash)
 *   - stdlib/src/abi/encoder.ts ([u8;32] flatten elementwise)
 *
 * v0 stops at `partial_address` — the final Grumpkin scalar-mul step
 *   address = ((preaddress * G) + ivpk_m).x
 * is not implemented on-device and is deferred to M8. The device shows
 * the host-supplied `expected_address` for review but does NOT
 * cryptographically refute it. Trust model: signing-key/path binding +
 * manifest-pinned class id + 3-pass fault recompute. See plan.md §8.1.
 *
 * Algorithm:
 *   args_hash       = poseidon2WithSeparator(64 byte-Frs, FUNCTION_ARGS)
 *   init_hash       = poseidon2WithSeparator([selector_as_Fr, args_hash], INITIALIZER)
 *   salted_init     = poseidon2WithSeparator([salt, init_hash, deployer], PARTIAL_ADDRESS)
 *   partial_address = poseidon2WithSeparator([class_id, salted_init], PARTIAL_ADDRESS)
 */
#pragma once

#include <stdint.h>

/**
 * Compute the partial-address chain for an EcdsaKAccount deploy.
 *
 * The signing pubkey is fed as raw 32+32 BE bytes (matching the device's
 * BIP-32 derivation output). The ctor selector is the low 4 bytes; the
 * device synthesizes the 32-byte Fr encoding internally (BE zero-padded).
 *
 * On success returns 0 and fills:
 *   out_init_hash       — `init_hash_local` for the M7 P3 session struct
 *   out_partial_address — `partial_address_local` for the M7 P3 session struct
 *
 * Returns negative on Fr arithmetic failure (propagated from poseidon2).
 *
 * The buffers MUST be distinct from any inputs the caller cares about
 * post-call. Caller is responsible for zeroing them on any non-success path.
 */
int az_deploy_compute_partial_address(
    const uint8_t signing_pubkey_x[32],
    const uint8_t signing_pubkey_y[32],
    uint32_t ctor_selector_u32,
    const uint8_t salt[32],
    const uint8_t deployer[32],
    const uint8_t account_class_id[32],
    uint8_t out_args_hash[32],
    uint8_t out_init_hash[32],
    uint8_t out_partial_address[32]);

/**
 * M10 — partial-address for a SchnorrAccount deploy. Same init/salted/partial
 * chain, but the ctor args are the 2-Fr Grumpkin pubkey (signing_pub_key_x,
 * signing_pub_key_y), so args_hash = computeVarArgsHash([P.x, P.y]). Used by the
 * Schnorr B3 consumer recompute + the Schnorr deploy verification.
 */
int az_schnorr_compute_partial_address(const uint8_t pubkey_x[32], const uint8_t pubkey_y[32],
                                       uint32_t ctor_selector_u32, const uint8_t salt[32],
                                       const uint8_t deployer[32],
                                       const uint8_t account_class_id[32],
                                       uint8_t out_partial_address[32]);
