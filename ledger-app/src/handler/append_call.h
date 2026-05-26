#pragma once

#include "buffer.h"

/**
 * APPEND_CALL (INS 0x06) — buffer one call into the active L4 session.
 *
 * Body layout (97 bytes):
 *   uint8_t args_hash[32]              // canonical Fr BE
 *   uint8_t function_selector[32]      // canonical Fr BE, high 28 bytes must be zero
 *   uint8_t target_address[32]         // canonical Fr BE
 *   uint8_t flags                      // L4_CALL_FLAG_*; bits >2 must be zero
 *
 * State precondition: G_l4_session.state == L4_HEADER_PARSED and
 *                     calls_received < call_count.
 *
 * Side effects: appends to G_l4_session.calls[calls_received], increments
 * calls_received, transitions to L4_CALLS_COMPLETE iff this was the last
 * real call. Returns SW=9000 on success.
 */
int handler_append_call(buffer_t *cdata);
