/**
 * M8 Phase 6 — Aztec account key/address derivation. See account_keys.h.
 *
 * Depends only on poseidon2 (Fr) + grumpkin EC; no BOLOS. Host-parity-tested
 * against the Phase 0 golden vectors in grumpkin-account-parity.test.ts.
 */
#include "account_keys.h"

#include <string.h>

#include "wire.h"
#include "../crypto/grumpkin/mul_generator.h"
#include "../crypto/grumpkin/point.h"
#include "../crypto/poseidon2/fr.h"
#include "../crypto/poseidon2/poseidon2.h"

int az_account_public_keys_hash(const az_affine_t *npk, const az_affine_t *ivpk,
                                const az_affine_t *ovpk, const az_affine_t *tpk,
                                uint8_t out_hash[32]) {
  /* 12 fields: [x, y, is_infinite=0] per pubkey, order npk/ivpk/ovpk/tpk.
   * Matches PublicKeys.hash() -> poseidon2HashWithSeparator over the four
   * Point.toFields() = [x, y, is_infinite]. */
  uint8_t fields[12 * 32];
  memset(fields, 0, sizeof(fields)); /* zeroes the three is_infinite slots */
  memcpy(fields + 0 * 32, npk->x, 32);
  memcpy(fields + 1 * 32, npk->y, 32);
  memcpy(fields + 3 * 32, ivpk->x, 32);
  memcpy(fields + 4 * 32, ivpk->y, 32);
  memcpy(fields + 6 * 32, ovpk->x, 32);
  memcpy(fields + 7 * 32, ovpk->y, 32);
  memcpy(fields + 9 * 32, tpk->x, 32);
  memcpy(fields + 10 * 32, tpk->y, 32);
  return az_poseidon2_hash_with_separator(fields, 12, L4_SEP_PUBLIC_KEYS_HASH, out_hash);
}

int az_account_address(const uint8_t public_keys_hash[32], const uint8_t partial_address[32],
                       const az_affine_t *ivpk, uint8_t out_address[32]) {
  /* preaddress = poseidon2_with_sep([publicKeysHash, partialAddress], CONTRACT_ADDRESS_V1). */
  uint8_t pre_in[2 * 32];
  memcpy(pre_in + 0 * 32, public_keys_hash, 32);
  memcpy(pre_in + 1 * 32, partial_address, 32);
  uint8_t preaddress[32];
  int rc = az_poseidon2_hash_with_separator(pre_in, 2, L4_SEP_CONTRACT_ADDR_V1, preaddress);
  if (rc != 0) return rc;

  /* [preaddress]G  (preaddress < Fr < Fq, so always a valid Grumpkin scalar). */
  uint8_t gx[32], gy[32];
  if (!grumpkin_scalar_mul_generator(gx, gy, preaddress)) {
    return -1; /* infinity — cryptographically impossible for a real preaddress */
  }

  /* addressPoint = [preaddress]G + ivpk_m. Lift [preaddress]G (affine) to
   * Jacobian (z=1) then mixed-add the affine ivpk. */
  grumpkin_point_t acc;
  if (!fr_from_bytes_be(&acc.x, gx) || !fr_from_bytes_be(&acc.y, gy)) {
    return -1;
  }
  fr_from_u64(&acc.z, 1);

  fr_t qx, qy;
  if (!fr_from_bytes_be(&qx, ivpk->x) || !fr_from_bytes_be(&qy, ivpk->y)) {
    return -1;
  }

  grumpkin_point_t sum;
  grumpkin_point_add_affine(&sum, &acc, &qx, &qy);

  uint8_t sx[32], sy[32];
  if (!grumpkin_point_to_affine_be(sx, sy, &sum)) {
    return -1; /* infinity */
  }
  memcpy(out_address, sx, 32); /* address = addressPoint.x */
  return 0;
}
