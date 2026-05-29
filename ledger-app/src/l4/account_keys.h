/**
 * M8 Phase 6 — Aztec account key/address derivation (the verification core).
 *
 * Pure functions (no BOLOS dependency beyond poseidon2 + grumpkin, both of
 * which build host-side) so they parity-test against the Phase 0 golden vectors
 * before they're wired into begin_deploy_account.
 *
 * These reproduce, on-device, the host computations the deploy handler must NOT
 * trust the host to have done honestly:
 *   - publicKeysHash = PublicKeys.hash()       (stdlib/keys/public_keys.ts:75)
 *   - address        = computeAddress(...)     (stdlib/keys/derivation.ts:50)
 *
 * Field reminder: Grumpkin point coordinates live in the BN254 SCALAR field
 * (poseidon2 fr_t). publicKeysHash + preaddress are poseidon2 over Fr. See
 * crypto/grumpkin/point.h for the full field-assignment rationale.
 */
#pragma once

#include <stdint.h>

/** Affine Grumpkin point as 32-byte big-endian coordinates (Fr). */
typedef struct {
  uint8_t x[32];
  uint8_t y[32];
} az_affine_t;

/**
 * publicKeysHash = poseidon2_with_sep(
 *   [npk.x, npk.y, 0, ivpk.x, ivpk.y, 0, ovpk.x, ovpk.y, 0, tpk.x, tpk.y, 0],
 *   DomainSeparator.PUBLIC_KEYS_HASH )
 *
 * The 12 fields are Point.toFields() = [x, y, is_infinite] per master pubkey,
 * with is_infinite = 0 (master pubkeys are always finite). Order is
 * npk, ivpk, ovpk, tpk.
 *
 * @return 0 on success, negative on poseidon2 failure.
 */
int az_account_public_keys_hash(const az_affine_t *npk, const az_affine_t *ivpk,
                                const az_affine_t *ovpk, const az_affine_t *tpk,
                                uint8_t out_hash[32]);

/**
 * address = ( [preaddress]G + ivpk_m ).x  where
 * preaddress = poseidon2_with_sep([public_keys_hash, partial_address],
 *                                 DomainSeparator.CONTRACT_ADDRESS_V1).
 *
 * preaddress (an Fr < Fr.MODULUS < Fq.MODULUS) is reinterpreted as a Grumpkin
 * scalar — always in range, no reduction needed.
 *
 * @return 0 on success, negative on poseidon2 failure or a degenerate
 *         (infinity) address point.
 */
int az_account_address(const uint8_t public_keys_hash[32], const uint8_t partial_address[32],
                       const az_affine_t *ivpk, uint8_t out_address[32]);
