/**
 * APDU dispatcher for the Aztec Ledger app.
 *
 * Single in-flight context (final critique §3) — no session_id in the wire format.
 * Session state in `G_context` is zeroed by each handler on entry.
 */

#include <stdint.h>
#include <stdbool.h>

#include "buffer.h"
#include "io.h"
#include "ledger_assert.h"

#include "dispatcher.h"
#include "../constants.h"
#include "../globals.h"
#include "../types.h"
#include "../sw.h"
#include "../handler/get_version.h"
#include "../handler/get_app_name.h"
#include "../handler/get_public_key.h"
#include "../handler/sign_outer_hash.h"

int apdu_dispatcher(const command_t *cmd) {
    LEDGER_ASSERT(cmd != NULL, "NULL cmd");

    if (cmd->cla != CLA) {
        return io_send_sw(SWO_INVALID_CLA);
    }

    buffer_t buf = {0};

    switch (cmd->ins) {
        case INS_GET_VERSION:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }
            return handler_get_version();

        case INS_GET_CAPS: {
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }
            // L2 build advertises K1 only. L4 / L5 builds OR in CAPS_CLEAR_SIGN / CAPS_GRUMPKIN.
            uint32_t caps = CAPS_K1;
            uint8_t caps_be[4] = {
                (uint8_t)(caps >> 24), (uint8_t)(caps >> 16),
                (uint8_t)(caps >> 8), (uint8_t)caps,
            };
            return io_send_response_pointer(caps_be, sizeof(caps_be), SWO_SUCCESS);
        }

        case INS_GET_PUBLIC_KEY:
            // L2: only p1=0 (no display) supported. p1=1 (display) is reserved for L4
            // and rejected here — codex L2 MINOR #7 (no advertise-and-discard).
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) {
                return io_send_sw(SWO_WRONG_DATA_LENGTH);
            }
            buf.ptr = cmd->data;
            buf.size = cmd->lc;
            buf.offset = 0;
            return handler_get_public_key(&buf, false);

        case INS_SIGN_OUTER_HASH:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return io_send_sw(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) {
                return io_send_sw(SWO_WRONG_DATA_LENGTH);
            }
            buf.ptr = cmd->data;
            buf.size = cmd->lc;
            buf.offset = 0;
            return handler_sign_outer_hash(&buf);

        case INS_BEGIN_AUTHWIT:
        case INS_APPEND_CALL:
        case INS_FINALIZE_AND_SIGN:
        case INS_ABORT:
            return io_send_sw(SWO_INVALID_INS);

        default:
            return io_send_sw(SWO_INVALID_INS);
    }
}
