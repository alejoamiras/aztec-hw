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
    L4_IDLE = 0,                /* no session — only BEGIN_AUTHWIT / BEGIN_DEPLOY accepted */
    L4_HEADER_PARSED,           /* BEGIN_AUTHWIT done, awaiting APPEND_CALL × call_count */
    L4_CALLS_COMPLETE,          /* all real calls received, awaiting FINALIZE_AND_SIGN */
    /* M7 P3 — clear-signed deploy. Mutually exclusive with the AUTHWIT path:
     * BEGIN_DEPLOY_ACCOUNT only accepted when state == L4_IDLE; otherwise
     * returns SW_DEPLOY_CONTEXT_WRONG_STATE. Likewise BEGIN_AUTHWIT is
     * rejected when state == L4_DEPLOY_CONTEXT. ABORT zeroes either path. */
    L4_DEPLOY_CONTEXT,          /* BEGIN_DEPLOY_ACCOUNT done, awaiting FINALIZE_DEPLOY_AND_SIGN */
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

    /* M-audit P4 / AHW-018 (wire v3): the host-selected account template + salt that
     * B3 re-derives the address for. profile_id is allowlisted + paired with curve_id;
     * salt is any canonical Fr. The device still binds `consumer` to the address it
     * derives from (path, profile, salt, its OWN keys) — derive-don't-trust. */
    uint8_t profile_id;
    uint8_t salt[L4_FR_BYTES];

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

/** Wipe `G_l4_session` AND `G_l4_deploy_session` to zero. Safe to call
 * from any state. Both must be cleared together because the two paths
 * share the `state` enum semantics. */
void l4_session_reset(void);

/* --- M7 P3: clear-signed deploy session ------------------------------ */

/**
 * Deploy session state. Mutually exclusive with the AUTHWIT path —
 * see `l4_state_e`. Populated entirely by `INS_BEGIN_DEPLOY_ACCOUNT`;
 * `INS_FINALIZE_DEPLOY_AND_SIGN` adds only `claimed_outer_hash`.
 *
 * `partial_address_local` is the DEVICE-recomputed (poseidon2-chain)
 * value derived from BIP-32 signing pubkey + manifest-pinned class id +
 * salt + ctor selector + Noir-ABI-encoded ctor args.
 *
 * M8 P6: the device now completes the Grumpkin EC step too — it derives its
 * own viewing keys from its seed, computes `public_keys_hash_local` +
 * `address_local`, and verifies the host-supplied `public_keys_hash` /
 * `expected_address` against them in BEGIN (rejecting on mismatch). So the
 * host-supplied fields are now cryptographically REFUTED, not merely stored.
 * Trust model: device verifies signing-pubkey/path + manifest-pinned class +
 * 3-pass partial recompute + device-derived publicKeysHash/address equality.
 * The M7 "does not defend against protocol-key spoofing" caveat is closed.
 */
typedef struct {
    /* From BEGIN_DEPLOY_ACCOUNT */
    uint8_t manifest_version;
    uint8_t profile_id;          /* index into CS_DEPLOY_PROFILES */
    uint8_t curve_id;
    uint8_t path_scheme;
    uint8_t bip32_path_len;
    uint32_t bip32_path[MAX_BIP32_PATH_LEN];

    uint8_t chain_id[L4_FR_BYTES];
    uint8_t protocol_version[L4_FR_BYTES];
    uint8_t tx_nonce[L4_FR_BYTES];
    uint8_t salt[L4_FR_BYTES];
    uint8_t public_keys_hash[L4_FR_BYTES];
    uint8_t expected_address[L4_FR_BYTES];

    /* Device-recomputed values (parity pass 1+2 before UI). */
    uint8_t args_hash_local[L4_FR_BYTES];  /* poseidon2(pubkey_64_bytefrs, FUNCTION_ARGS) */
    uint8_t init_hash_local[L4_FR_BYTES];
    uint8_t partial_address_local[L4_FR_BYTES];

    /* M8 P6 — device-DERIVED + verified account identity. These are the
     * device's own publicKeysHash + address (from its seed-derived viewing
     * keys), already cross-checked against the host-supplied public_keys_hash /
     * expected_address in BEGIN. PUBLIC values (codex P6 design: never cache the
     * secret sk or viewing scalars). FINALIZE re-derives from the seed and
     * compares against these before signing; the UI displays address_local. */
    uint8_t public_keys_hash_local[L4_FR_BYTES];
    uint8_t address_local[L4_FR_BYTES];

    /* From FINALIZE_DEPLOY_AND_SIGN. */
    uint8_t claimed_outer_hash[L4_FR_BYTES];
    /* True once FINALIZE_DEPLOY_AND_SIGN has stored claimed_outer_hash. A
     * proper state bit instead of zero-scanning the hash (codex P6d review
     * NIT): Fr(0) is a valid canonical hash value, so "all zero" must not be
     * conflated with "not received". Cleared by l4_session_reset (struct zero). */
    bool claimed_outer_hash_received;
} l4_deploy_session_t;

extern l4_deploy_session_t G_l4_deploy_session;
