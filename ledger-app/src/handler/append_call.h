#pragma once

#include "buffer.h"

/**
 * APPEND_CALL (INS 0x06) — buffer one call into the active L4 session.
 *
 * Body layout (M5.1 wire v2; up to L4_APPEND_CALL_BODY_MAX = 226 bytes):
 *   uint8_t args_hash[32]              // canonical Fr BE (host-claimed)
 *   uint8_t function_selector[32]      // canonical Fr BE, high 28 bytes must be zero
 *   uint8_t target_address[32]         // canonical Fr BE
 *   uint8_t flags                      // L4_CALL_FLAG_*; bits >2 must be zero
 *   uint8_t args_count                 // 0..L4_MAX_ARGS (=4)
 *   uint8_t args[args_count][32]       // raw Fr args, canonical
 *
 * State precondition: G_l4_session.state == L4_HEADER_PARSED and
 *                     calls_received < call_count.
 *
 * Side effects (M5.2 strict-allowlist gates active):
 *  - Looks up (target, selector) in CS_REGISTRY + CS_VERBS; reject SW_*_MISS
 *  - Verifies args_count + visibility + (for 4-arg transfers) from == consumer
 *  - Recomputes args_hash from raw args (double-pass + cross-check), compares
 *    to host-claimed; reject SW_HASH_MISMATCH on any disagreement
 *  - OVERWRITES slot->args_hash with device-recomputed value (trusted-session
 *    invariant from codex M5 final-review MAJOR #4)
 *  - Increments calls_received, transitions to L4_CALLS_COMPLETE iff last call
 *  - Returns SW=9000 on success.
 */
int handler_append_call(buffer_t *cdata);
