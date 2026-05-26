#pragma once

#include "buffer.h"

/**
 * FINALIZE_AND_SIGN (INS 0x07) — verify host parity, then sign sha256(outer_hash).
 *
 * Body layout (32 bytes):
 *   uint8_t claimed_outer_hash[32]  // canonical Fr BE
 *
 * State precondition: G_l4_session.state == L4_CALLS_COMPLETE.
 *
 * Algorithm (deep plan §3 + §5 fault hardening):
 *   1. Read claimed_outer_hash.
 *   2. Recompute outer_hash on-device.
 *   3. Compare — abort on mismatch.
 *   4. Recompute AGAIN, compare AGAIN — fault detection.
 *   5. Display verified-calls UI (calls list + consumer + outer_hash).
 *   6. On user approval: recompute one MORE time, compare, then sign.
 *
 * Returns r ‖ s (64 B) + SW=9000 on approval.
 */
int handler_finalize_and_sign(buffer_t *cdata);

/* Called by UI on user approval — does the 3rd recompute then signs. */
int finalize_after_approval(void);

/* Called by UI on user reject — wipes session, returns SW=6985. */
int finalize_rejected(void);
