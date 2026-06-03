#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "constants.h"

/**
 * AHW-095 (W1) — out-of-band immutable snapshot of what a review screen showed.
 *
 * The blind-sign approval used to sign `G_context.sign_info.outer_hash` +
 * `G_context.bip32_path` re-read at approval time. Those live in (or beside) the
 * `pk_info`/`sign_info` union, so a mid-review `GET_PUBLIC_KEY` — or a RAM glitch
 * between the review screen and the approval callback — could change what the
 * device signs vs. what the user saw.
 *
 * This snapshot lives OUTSIDE `global_ctx_t` (its own static), captured at
 * review-draw time. The approval callback signs FROM the snapshot (never the
 * live globals) and compares the live `G_context` back to it, rejecting on any
 * mismatch (`SW_REVIEW_STATE_MISMATCH`). Single-use: disarmed once consumed.
 */
typedef struct {
    bool armed;
    uint8_t bip32_path_len;
    uint32_t bip32_path[MAX_BIP32_PATH_LEN];
    uint8_t outer_hash[AZTEC_OUTER_HASH_LEN];
} blind_sign_snapshot_t;

/** Capture the reviewed `(path, outer_hash)` and arm. Call at review-draw time. */
void review_snapshot_capture_blind_sign(const uint32_t *path, uint8_t path_len,
                                        const uint8_t outer_hash[AZTEC_OUTER_HASH_LEN]);

/**
 * Returns the armed snapshot iff it is armed AND the live values match it
 * (length-checked, then a difference-OR over path words + hash bytes). Returns
 * NULL otherwise — on NULL the caller MUST reject and disarm. The caller should
 * copy the values out and `review_snapshot_disarm()` immediately (single-use).
 */
const blind_sign_snapshot_t *review_snapshot_verify_blind_sign(
    const uint32_t *live_path, uint8_t live_path_len,
    const uint8_t live_outer_hash[AZTEC_OUTER_HASH_LEN]);

/** Clear + disarm (after sign, on reject, or on any new APDU dispatch). */
void review_snapshot_disarm(void);

#define REVIEW_IDENTITY_ADDR_LEN 32 /* an Aztec address is one 32-byte Fr */

/**
 * AHW-099 (W1 sibling) + AHW-112 — display-identity snapshot for the deploy
 * review (Account #N + the device-derived address) and the reveal review
 * (#N only). The deploy signature / revealed secret are ALREADY over a fresh
 * device recompute (sovereign), so this is the display-integrity half: capture
 * the shown identity at review-draw time, verify-or-reject in the approval
 * callback, so a render→approval glitch to the displayed #N / address becomes a
 * clean `SW_REVIEW_STATE_MISMATCH` instead of a silent approve-of-a-different-id.
 * A SEPARATE static from the blind-sign snapshot — different review flow, only
 * one review is on screen at a time so they are used sequentially.
 */
typedef struct {
    bool armed;
    bool has_address;
    uint32_t account_index;
    uint8_t address[REVIEW_IDENTITY_ADDR_LEN];
} review_identity_snapshot_t;

/** Capture the reviewed identity + arm. `address_or_null` NULL → reveal (no address). */
void review_snapshot_capture_identity(uint32_t account_index, const uint8_t *address_or_null);

/**
 * Returns the armed identity snapshot iff armed AND the live values match: the
 * account index, the address-presence flag, and (when present) all 32 address
 * bytes via difference-OR. NULL otherwise — on NULL the caller MUST reject and
 * disarm. `live_address_or_null`'s NULL-ness must match what was captured.
 */
const review_identity_snapshot_t *review_snapshot_verify_identity(
    uint32_t live_account_index, const uint8_t *live_address_or_null);

/** Clear + disarm the identity snapshot (after approval consumes it, or on reject). */
void review_snapshot_disarm_identity(void);
