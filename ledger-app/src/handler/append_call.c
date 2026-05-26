/**
 * APPEND_CALL handler — M5.2 strict-allowlist gates + args_hash recompute.
 *
 * Sequence:
 *   1. Parse wire body (args_hash, selector, target, flags, args_count, args[])
 *      with canonical-Fr checks.
 *   2. Strict-allowlist lookups (codex M5 final-review BLOCKER):
 *      - target_address must hit CS_REGISTRY (else SW_REGISTRY_MISS)
 *      - (kind, selector_u32) must hit CS_VERBS (else SW_DECODER_MISS)
 *      - args_count must equal verb.wire_arg_count (else SW_DECODER_DESYNC)
 *      - flags.is_public must match verb.is_public (else SW_VISIBILITY_MISMATCH)
 *      - 4-arg TRANSFER_* verbs: args[0] (from) must equal consumer
 *        (else SW_DELEGATED_SPEND_UNSUPPORTED — removes the delegated-spend
 *        surface the PoC UI cannot honestly explain).
 *   3. Recompute args_hash on-device TWICE; cross-check both passes equal
 *      and equal to the host-claimed args_hash. Reject SW_HASH_MISMATCH on
 *      any disagreement.
 *   4. OVERWRITE `slot->args_hash` with the device-recomputed value
 *      (codex M5 final-review MAJOR #4 trusted-session invariant: finalize
 *      and parity.c read this field; they must never see a host-claimed value
 *      after this point).
 *   5. Advance state machine.
 */
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "os.h"
#include "io.h"
#include "buffer.h"

#include "append_call.h"
#include "../constants.h"
#include "../sw.h"
#include "../l4/fr_canonical.h"
#include "../l4/session.h"
#include "../l4/wire.h"
#include "../clear_signing_v0/args_hash.h"
#include "../clear_signing_v0/registry.gen.h"
#include "../clear_signing_v0/selectors.gen.h"

static int reject(uint16_t sw) {
    l4_session_reset();
    return io_send_sw(sw);
}

/* `function_selector` is a Fr value but the Aztec ABI semantics constrain it
 * to fit in u32 (the high 28 bytes must be exactly zero). Anything outside
 * that range is host fraud — reject before display. */
static bool selector_fits_u32(const uint8_t bytes[L4_FR_BYTES]) {
    for (int i = 0; i < 28; i++) {
        if (bytes[i] != 0) return false;
    }
    return true;
}

static uint32_t selector_u32_from_be(const uint8_t bytes[L4_FR_BYTES]) {
    return ((uint32_t)bytes[28] << 24)
         | ((uint32_t)bytes[29] << 16)
         | ((uint32_t)bytes[30] << 8)
         | (uint32_t)bytes[31];
}

/* Constant-time-ish 32-byte compare (returns 0 on equal). */
static int ct_memcmp32(const uint8_t a[L4_FR_BYTES], const uint8_t b[L4_FR_BYTES]) {
    uint8_t diff = 0;
    for (int i = 0; i < L4_FR_BYTES; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff;
}

static bool verb_is_4arg_transfer(uint8_t verb_id) {
    switch (verb_id) {
        case CS_VERB_TRANSFER_PRIV_PUB:
        case CS_VERB_TRANSFER_PRIV_PRIV:
        case CS_VERB_TRANSFER_PUB_PRIV:
        case CS_VERB_TRANSFER_PUB_PUB:
            return true;
        default:
            return false;
    }
}

int handler_append_call(buffer_t *cdata) {
    if (G_l4_session.state != L4_HEADER_PARSED) return reject(SWO_INVALID_INS);
    if (G_l4_session.calls_received >= G_l4_session.call_count) {
        return reject(SWO_INVALID_INS);
    }

    l4_call_t *slot = &G_l4_session.calls[G_l4_session.calls_received];

    /* --- Parse wire body --------------------------------------------------- */

    uint8_t host_claimed_args_hash[L4_FR_BYTES];
    if (!buffer_read_bytes(cdata, host_claimed_args_hash, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(host_claimed_args_hash)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, slot->function_selector, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(slot->function_selector)) return reject(SW_HASH_MISMATCH);
    if (!selector_fits_u32(slot->function_selector)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, slot->target_address, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(slot->target_address)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_u8(cdata, &slot->flags)) return reject(SWO_WRONG_DATA_LENGTH);
    if (slot->flags & ~L4_CALL_FLAG_MASK) return reject(SWO_WRONG_DATA_LENGTH);

    if (!buffer_read_u8(cdata, &slot->args_count)) return reject(SWO_WRONG_DATA_LENGTH);
    if (slot->args_count > L4_MAX_ARGS) return reject(SW_DECODER_DESYNC);

    memset(slot->args, 0, sizeof(slot->args));
    for (uint8_t i = 0; i < slot->args_count; i++) {
        if (!buffer_read_bytes(cdata, slot->args[i], L4_FR_BYTES)) {
            return reject(SWO_WRONG_DATA_LENGTH);
        }
        if (!l4_fr_is_canonical(slot->args[i])) return reject(SW_HASH_MISMATCH);
    }

    if (cdata->size != cdata->offset) return reject(SWO_WRONG_DATA_LENGTH);

    /* --- Strict-allowlist gates ------------------------------------------- */

    const cs_registry_entry_t *reg = cs_registry_lookup(slot->target_address);
    if (reg == NULL) return reject(SW_REGISTRY_MISS);

    uint32_t sel_u32 = selector_u32_from_be(slot->function_selector);
    const cs_verb_entry_t *verb = cs_verb_lookup(reg->kind, sel_u32);
    if (verb == NULL) return reject(SW_DECODER_MISS);

    if (slot->args_count != verb->wire_arg_count) return reject(SW_DECODER_DESYNC);

    const bool host_is_public = (slot->flags & L4_CALL_FLAG_PUBLIC) != 0;
    const bool verb_is_public = verb->is_public != 0;
    if (host_is_public != verb_is_public) return reject(SW_VISIBILITY_MISMATCH);

    /* `from == consumer` for 4-arg TRANSFER_* verbs (codex final-review §4). */
    if (verb_is_4arg_transfer(verb->verb)) {
        if (ct_memcmp32(slot->args[0], G_l4_session.consumer) != 0) {
            return reject(SW_DELEGATED_SPEND_UNSUPPORTED);
        }
    }

    /* --- args_hash recompute (double + cross-check, fault hardening) ------ */

    uint8_t device_args_hash_a[L4_FR_BYTES];
    uint8_t device_args_hash_b[L4_FR_BYTES];
    if (cs_compute_args_hash(slot->function_selector, slot->args, slot->args_count,
                             host_is_public, device_args_hash_a) != 0) {
        return reject(SW_HASH_MISMATCH);
    }
    if (cs_compute_args_hash(slot->function_selector, slot->args, slot->args_count,
                             host_is_public, device_args_hash_b) != 0) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(device_args_hash_a, device_args_hash_b) != 0) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(device_args_hash_a, host_claimed_args_hash) != 0) {
        return reject(SW_HASH_MISMATCH);
    }

    /* Trusted-session invariant (codex M5 final-review MAJOR #4):
     * after this point, slot->args_hash is the device-recomputed value.
     * parity.c and finalize_and_sign.c read this field; they must NEVER
     * see a host-claimed value. */
    memcpy(slot->args_hash, device_args_hash_a, L4_FR_BYTES);

    G_l4_session.calls_received++;
    if (G_l4_session.calls_received == G_l4_session.call_count) {
        G_l4_session.state = L4_CALLS_COMPLETE;
    }

    return io_send_sw(SWO_SUCCESS);
}
