/**
 * M8 Phase 6d — deploy authwit outer_hash recomputation. See header.
 *
 * Mirrors the field layout of l4/parity.c::l4_compute_outer_hash, but for the
 * fixed deploy call list (one sponsor call + 4 padding) synthesized from
 * device-verified / manifest-pinned values rather than streamed APPEND_CALLs.
 * Kept self-contained (not folded into parity.c) so the working transfer
 * outer_hash path is untouched.
 */
#include "deploy_outer_hash.h"

#include <string.h>

#include "wire.h"
#include "../crypto/poseidon2/poseidon2.h"

#define DOH_PAYLOAD_FIELD_COUNT (L4_MAX_CALLS * 6u + 1u) /* 5 calls x 6 + tx_nonce = 31 */
#define DOH_OUTER_FIELD_COUNT 4u                          /* consumer, chain, version, inner */

static void fr_zero_bytes(uint8_t out[L4_FR_BYTES]) {
  memset(out, 0, L4_FR_BYTES);
}

static void fr_one_bytes(uint8_t out[L4_FR_BYTES]) {
  memset(out, 0, L4_FR_BYTES - 1);
  out[L4_FR_BYTES - 1] = 1;
}

/* u32 selector -> 32-byte BE Fr (28 zero bytes then 4 selector bytes). */
static void selector_to_field(uint8_t out[L4_FR_BYTES], uint32_t selector) {
  memset(out, 0, L4_FR_BYTES);
  out[L4_FR_BYTES - 4] = (uint8_t)(selector >> 24);
  out[L4_FR_BYTES - 3] = (uint8_t)(selector >> 16);
  out[L4_FR_BYTES - 2] = (uint8_t)(selector >> 8);
  out[L4_FR_BYTES - 1] = (uint8_t)selector;
}

int az_deploy_compute_outer_hash(const uint8_t consumer[32], const uint8_t chain_id[32],
                                 const uint8_t protocol_version[32], const uint8_t tx_nonce[32],
                                 const uint8_t sponsor_fpc[32], uint32_t sponsor_selector,
                                 uint8_t out_outer_hash[32]) {
  /* Canonical padding call's args_hash = poseidon2([0], PUBLIC_CALLDATA). */
  uint8_t padding_args_hash[L4_FR_BYTES];
  uint8_t zero_field[L4_FR_BYTES];
  fr_zero_bytes(zero_field);
  if (az_poseidon2_hash_with_separator(zero_field, 1, L4_SEP_PUBLIC_CALLDATA, padding_args_hash) !=
      0) {
    return -1;
  }

  uint8_t payload[DOH_PAYLOAD_FIELD_COUNT * L4_FR_BYTES];
  size_t off = 0;

  /* Call 0 — sponsor_unconditionally(): args_hash=0, selector, target=fpc,
   * is_public=false (PRIVATE), hide_msg_sender=false, is_static=false. */
  fr_zero_bytes(payload + (off + 0) * L4_FR_BYTES);            /* args_hash = Fr(0) */
  selector_to_field(payload + (off + 1) * L4_FR_BYTES, sponsor_selector);
  memcpy(payload + (off + 2) * L4_FR_BYTES, sponsor_fpc, L4_FR_BYTES);
  fr_zero_bytes(payload + (off + 3) * L4_FR_BYTES);            /* is_public = false */
  fr_zero_bytes(payload + (off + 4) * L4_FR_BYTES);            /* hide_msg_sender = false */
  fr_zero_bytes(payload + (off + 5) * L4_FR_BYTES);            /* is_static = false */
  off += 6;

  /* Calls 1-4 — canonical padding. */
  for (uint8_t i = 1; i < L4_MAX_CALLS; i++) {
    memcpy(payload + (off + 0) * L4_FR_BYTES, padding_args_hash, L4_FR_BYTES);
    fr_zero_bytes(payload + (off + 1) * L4_FR_BYTES); /* selector = 0 */
    fr_zero_bytes(payload + (off + 2) * L4_FR_BYTES); /* target   = 0 */
    fr_one_bytes(payload + (off + 3) * L4_FR_BYTES);  /* is_public = true */
    fr_zero_bytes(payload + (off + 4) * L4_FR_BYTES); /* hide_msg_sender = false */
    fr_zero_bytes(payload + (off + 5) * L4_FR_BYTES); /* is_static = false */
    off += 6;
  }

  /* tx_nonce as the 31st field. */
  memcpy(payload + off * L4_FR_BYTES, tx_nonce, L4_FR_BYTES);
  off += 1;
  if (off != DOH_PAYLOAD_FIELD_COUNT) return -1;

  uint8_t inner[L4_FR_BYTES];
  if (az_poseidon2_hash_with_separator(payload, DOH_PAYLOAD_FIELD_COUNT, L4_SEP_SIGNATURE_PAYLOAD,
                                       inner) != 0) {
    return -1;
  }

  uint8_t outer_payload[DOH_OUTER_FIELD_COUNT * L4_FR_BYTES];
  memcpy(outer_payload + 0 * L4_FR_BYTES, consumer, L4_FR_BYTES);
  memcpy(outer_payload + 1 * L4_FR_BYTES, chain_id, L4_FR_BYTES);
  memcpy(outer_payload + 2 * L4_FR_BYTES, protocol_version, L4_FR_BYTES);
  memcpy(outer_payload + 3 * L4_FR_BYTES, inner, L4_FR_BYTES);

  return az_poseidon2_hash_with_separator(outer_payload, DOH_OUTER_FIELD_COUNT,
                                          L4_SEP_AUTHWIT_OUTER, out_outer_hash);
}
