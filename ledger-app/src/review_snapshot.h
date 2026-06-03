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
