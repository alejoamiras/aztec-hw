/**
 * Outer-hash reconstruction implementation.
 *
 * Algorithm (mirrors `yarn-project/entrypoints/src/encoding.ts` +
 *           `yarn-project/stdlib/src/auth_witness/auth_witness.ts`):
 *
 *   inner_hash  = poseidon2HashWithSeparator(
 *                   [ for c in pad_to_5(calls): c.args_hash, c.selector,
 *                                                c.target, c.is_public,
 *                                                c.hide_msg_sender, c.is_static,
 *                     tx_nonce ],
 *                   SIGNATURE_PAYLOAD)
 *   outer_hash  = poseidon2HashWithSeparator(
 *                   [ consumer, chain_id, protocol_version, inner_hash ],
 *                   AUTHWIT_OUTER)
 *
 * Canonical padding call (`FunctionCall.empty()`):
 *   args_hash         = poseidon2HashWithSeparator([Fr(0)], PUBLIC_CALLDATA)
 *   function_selector = 0
 *   target_address    = 0
 *   is_public         = true   (yes, true — not false; see deep plan §3)
 *   hide_msg_sender   = false
 *   is_static         = false
 */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "parity.h"
#include "session.h"
#include "wire.h"

#include "../crypto/poseidon2/poseidon2.h"

/* Number of fields fed into the SIGNATURE_PAYLOAD hash: 5 calls × 6 fields + tx_nonce. */
#define L4_PAYLOAD_FIELD_COUNT (L4_MAX_CALLS * 6u + 1u)
#define L4_OUTER_FIELD_COUNT 4u /* consumer, chain_id, protocol_version, inner_hash */

static void fr_zero_bytes(uint8_t out[L4_FR_BYTES]) {
    memset(out, 0, L4_FR_BYTES);
}

/* Write Fr(1) as 32 BE bytes (i.e. 31 zeros then 0x01). */
static void fr_one_bytes(uint8_t out[L4_FR_BYTES]) {
    memset(out, 0, L4_FR_BYTES - 1);
    out[L4_FR_BYTES - 1] = 1;
}

/* args_hash for the canonical padding call: poseidon2HashWithSeparator([0], PUBLIC_CALLDATA). */
static int compute_padding_args_hash(uint8_t out[L4_FR_BYTES]) {
    uint8_t zero_field[L4_FR_BYTES];
    fr_zero_bytes(zero_field);
    return az_poseidon2_hash_with_separator(zero_field, 1, L4_SEP_PUBLIC_CALLDATA, out);
}

/* Append one call's 6 fields to the payload buffer at `*offset`. */
static void emit_call_fields(uint8_t *payload, size_t *offset, const l4_call_t *call) {
    memcpy(payload + (*offset) * L4_FR_BYTES, call->args_hash, L4_FR_BYTES);
    memcpy(payload + (*offset + 1) * L4_FR_BYTES, call->function_selector, L4_FR_BYTES);
    memcpy(payload + (*offset + 2) * L4_FR_BYTES, call->target_address, L4_FR_BYTES);

    uint8_t *is_public = payload + (*offset + 3) * L4_FR_BYTES;
    uint8_t *hide_ms = payload + (*offset + 4) * L4_FR_BYTES;
    uint8_t *is_static = payload + (*offset + 5) * L4_FR_BYTES;
    if (call->flags & L4_CALL_FLAG_PUBLIC) fr_one_bytes(is_public); else fr_zero_bytes(is_public);
    if (call->flags & L4_CALL_FLAG_HIDE_MSG_SENDER) fr_one_bytes(hide_ms); else fr_zero_bytes(hide_ms);
    if (call->flags & L4_CALL_FLAG_STATIC) fr_one_bytes(is_static); else fr_zero_bytes(is_static);

    *offset += 6;
}

/* Synthesize a padding call's 6 fields directly into payload at `*offset`,
 * using the pre-computed `padding_args_hash`. */
static void emit_padding_fields(uint8_t *payload, size_t *offset,
                                const uint8_t padding_args_hash[L4_FR_BYTES]) {
    memcpy(payload + (*offset) * L4_FR_BYTES, padding_args_hash, L4_FR_BYTES);
    fr_zero_bytes(payload + (*offset + 1) * L4_FR_BYTES); /* selector = 0 */
    fr_zero_bytes(payload + (*offset + 2) * L4_FR_BYTES); /* target   = 0 */
    fr_one_bytes(payload + (*offset + 3) * L4_FR_BYTES);  /* is_public = true */
    fr_zero_bytes(payload + (*offset + 4) * L4_FR_BYTES); /* hide_msg_sender = false */
    fr_zero_bytes(payload + (*offset + 5) * L4_FR_BYTES); /* is_static = false */
    *offset += 6;
}

bool l4_compute_outer_hash(uint8_t out_outer[L4_FR_BYTES], uint8_t out_inner[L4_FR_BYTES]) {
    if (G_l4_session.call_count > L4_MAX_CALLS) {
        return false; /* invariant — caller bug if this fires */
    }

    /* 1. Compute the canonical padding call's args_hash once. */
    uint8_t padding_args_hash[L4_FR_BYTES];
    if (compute_padding_args_hash(padding_args_hash) != 0) {
        return false;
    }

    /* 2. Build the 31-field payload. Allocated on the stack — 31 * 32 = 992 B,
     *    fits comfortably within the Ledger app's stack budget. */
    uint8_t payload[L4_PAYLOAD_FIELD_COUNT * L4_FR_BYTES];
    size_t offset = 0;

    for (uint8_t i = 0; i < G_l4_session.call_count; i++) {
        emit_call_fields(payload, &offset, &G_l4_session.calls[i]);
    }
    for (uint8_t i = G_l4_session.call_count; i < L4_MAX_CALLS; i++) {
        emit_padding_fields(payload, &offset, padding_args_hash);
    }

    /* tx_nonce as the 31st field. */
    memcpy(payload + offset * L4_FR_BYTES, G_l4_session.tx_nonce, L4_FR_BYTES);
    offset++;

    if (offset != L4_PAYLOAD_FIELD_COUNT) {
        return false; /* programming error */
    }

    /* 3. inner_hash = poseidon2HashWithSeparator(payload, SIGNATURE_PAYLOAD) */
    uint8_t inner[L4_FR_BYTES];
    if (az_poseidon2_hash_with_separator(payload, L4_PAYLOAD_FIELD_COUNT,
                                         L4_SEP_SIGNATURE_PAYLOAD, inner) != 0) {
        return false;
    }

    /* 4. outer_hash = poseidon2HashWithSeparator([consumer, chain_id, version, inner], AUTHWIT_OUTER) */
    uint8_t outer_payload[L4_OUTER_FIELD_COUNT * L4_FR_BYTES];
    memcpy(outer_payload + 0 * L4_FR_BYTES, G_l4_session.consumer, L4_FR_BYTES);
    memcpy(outer_payload + 1 * L4_FR_BYTES, G_l4_session.chain_id, L4_FR_BYTES);
    memcpy(outer_payload + 2 * L4_FR_BYTES, G_l4_session.protocol_version, L4_FR_BYTES);
    memcpy(outer_payload + 3 * L4_FR_BYTES, inner, L4_FR_BYTES);

    if (az_poseidon2_hash_with_separator(outer_payload, L4_OUTER_FIELD_COUNT,
                                         L4_SEP_AUTHWIT_OUTER, out_outer) != 0) {
        return false;
    }

    memcpy(out_inner, inner, L4_FR_BYTES);
    return true;
}
