/**
 * L4 session state — multi-APDU streaming context for the verified-calls flow.
 *
 * Kept separate from `G_context` (single-shot L2 state) so the BEGIN/APPEND/
 * FINALIZE pipeline can persist across APDUs without disturbing L2 invariants.
 *
 * The L4 session is single-in-flight: BEGIN always zeroes any prior state.
 * ABORT (or any non-9000 path) also zeroes. See codex deep plan §2 "Recovery/state".
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "../constants.h"
#include "wire.h"

typedef enum {
    L4_IDLE = 0,            /* no session — only BEGIN_AUTHWIT accepted */
    L4_HEADER_PARSED,       /* BEGIN done, awaiting APPEND_CALL × call_count */
    L4_CALLS_COMPLETE,      /* all real calls received, awaiting FINALIZE_AND_SIGN */
} l4_state_e;

typedef struct {
    uint8_t args_hash[L4_FR_BYTES];        /* Device-recomputed value, NOT host-claimed.
                                             * append_call.c overwrites with the result of
                                             * cs_compute_args_hash after the per-call parity
                                             * gate (trusted-session invariant, codex M5
                                             * final-review MAJOR #4). finalize/parity.c only
                                             * ever consumes this device-authored bytes. */
    uint8_t function_selector[L4_FR_BYTES];
    uint8_t target_address[L4_FR_BYTES];
    uint8_t flags; /* L4_CALL_FLAG_* */

    /* Clear-signing v0: raw args streamed alongside args_hash. Used by:
     *   - M5.2's device-side args_hash recompute (parity gate)
     *   - M5.3's decoder (semantic UI rendering)
     *   - M5.2's three-pass finalize re-derivation from stored raw args
     * `args_count` ∈ [0, L4_MAX_ARGS]; unused slots are explicitly zeroed. */
    uint8_t args_count;
    uint8_t args[L4_MAX_ARGS][L4_FR_BYTES];
} l4_call_t;

typedef struct {
    l4_state_e state;

    /* From BEGIN_AUTHWIT */
    uint8_t manifest_version;
    uint8_t curve_id;
    uint8_t path_scheme;
    uint8_t bip32_path_len;
    uint32_t bip32_path[MAX_BIP32_PATH_LEN];

    uint8_t consumer[L4_FR_BYTES];
    uint8_t chain_id[L4_FR_BYTES];
    uint8_t protocol_version[L4_FR_BYTES];
    uint8_t tx_nonce[L4_FR_BYTES];

    uint8_t call_count;    /* declared at BEGIN, 0..L4_MAX_CALLS */
    uint8_t calls_received; /* incremented per APPEND_CALL, 0..call_count */
    l4_call_t calls[L4_MAX_CALLS];

    /* Computed at FINALIZE (host-claimed value also stashed for UI). */
    uint8_t inner_hash[L4_FR_BYTES];
    uint8_t outer_hash[L4_FR_BYTES];
    uint8_t claimed_outer_hash[L4_FR_BYTES];
} l4_session_t;

extern l4_session_t G_l4_session;

/** Wipe `G_l4_session` to zero. Safe to call from any state. */
void l4_session_reset(void);
