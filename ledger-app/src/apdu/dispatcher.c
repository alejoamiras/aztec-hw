/**
 * APDU dispatcher for the Aztec Ledger app.
 *
 * Invariants:
 *   - Any non-0x9000 path zeroes `G_l4_session` (codex L4 BLOCKER): the
 *     `reject_dispatch()` helper wraps the early-return SW path so a
 *     malformed APDU mid-stream cannot leave a parked session live.
 *   - Any L2 INS (`GET_PUBLIC_KEY`, `SIGN_OUTER_HASH`, `GET_VERSION`,
 *     `GET_CAPS`) is treated as an L4 boundary — entering one ABORTs any
 *     in-flight verified-calls session (codex L4 MAJOR #1: stale-session
 *     lifetime). L4 INSes themselves manage their session reset rules
 *     (BEGIN zeros, ABORT zeros, FINALIZE/APPEND reject-paths zero).
 */

#include <stdint.h>
#include <stdbool.h>

#include "buffer.h"
#include "io.h"
#include "ledger_assert.h"

#include "dispatcher.h"
#include "../constants.h"
#include "../globals.h"
#include "../l4/session.h"
#include "../types.h"
#include "../sw.h"
#include "../handler/get_version.h"
#include "../handler/get_app_name.h"
#include "../handler/get_public_key.h"
#include "../handler/sign_outer_hash.h"
#include "../handler/begin_authwit.h"
#include "../handler/append_call.h"
#include "../handler/finalize_and_sign.h"
#include "../handler/abort_authwit.h"
#include "../handler/begin_deploy_account.h"
#include "../handler/finalize_deploy_and_sign.h"
#include "../handler/get_aztec_master_secret.h"

static buffer_t make_buf(const command_t *cmd) {
    buffer_t buf = {0};
    buf.ptr = cmd->data;
    buf.size = cmd->lc;
    buf.offset = 0;
    return buf;
}

/* Wraps `io_send_sw(sw)` with an L4 session reset, so EVERY non-9000 return
 * from the dispatcher honors the "non-0x9000 zeroes session state" rule. */
static int reject_dispatch(uint16_t sw) {
    l4_session_reset();
    return io_send_sw(sw);
}

int apdu_dispatcher(const command_t *cmd) {
    LEDGER_ASSERT(cmd != NULL, "NULL cmd");

    if (cmd->cla != CLA) {
        return reject_dispatch(SWO_INVALID_CLA);
    }

    buffer_t buf;

    switch (cmd->ins) {
        case INS_GET_VERSION:
            l4_session_reset(); /* L2 INSes don't share state with L4. */
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            return handler_get_version();

        case INS_GET_CAPS: {
            l4_session_reset();
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            uint32_t caps = CAPS_K1 | CAPS_CLEAR_SIGN;
            uint8_t caps_be[4] = {
                (uint8_t)(caps >> 24), (uint8_t)(caps >> 16),
                (uint8_t)(caps >> 8), (uint8_t)caps,
            };
            return io_send_response_pointer(caps_be, sizeof(caps_be), SWO_SUCCESS);
        }

        case INS_GET_PUBLIC_KEY:
            l4_session_reset();
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) return reject_dispatch(SWO_WRONG_DATA_LENGTH);
            buf = make_buf(cmd);
            return handler_get_public_key(&buf, false);

        case INS_SIGN_OUTER_HASH:
            l4_session_reset(); /* L2 blind-sign path — abort any L4 session. */
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) return reject_dispatch(SWO_WRONG_DATA_LENGTH);
            buf = make_buf(cmd);
            return handler_sign_outer_hash(&buf);

        case INS_BEGIN_AUTHWIT:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) return reject_dispatch(SWO_WRONG_DATA_LENGTH);
            buf = make_buf(cmd);
            return handler_begin_authwit(&buf);

        case INS_APPEND_CALL:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) return reject_dispatch(SWO_WRONG_DATA_LENGTH);
            buf = make_buf(cmd);
            return handler_append_call(&buf);

        case INS_FINALIZE_AND_SIGN:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) return reject_dispatch(SWO_WRONG_DATA_LENGTH);
            buf = make_buf(cmd);
            return handler_finalize_and_sign(&buf);

        case INS_ABORT:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            buf.ptr = cmd->data;
            buf.size = cmd->lc;
            buf.offset = 0;
            return handler_abort_authwit(&buf);

        /* M7 P3 — clear-signed deploy. Same shape as BEGIN_AUTHWIT/
         * APPEND_CALL/FINALIZE_AND_SIGN: BEGIN stores context + returns
         * SUCCESS; FINALIZE triggers the on-device review. */
        case INS_BEGIN_DEPLOY_ACCOUNT:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) return reject_dispatch(SWO_WRONG_DATA_LENGTH);
            buf = make_buf(cmd);
            return handler_begin_deploy_account(&buf);

        case INS_FINALIZE_DEPLOY_AND_SIGN:
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) return reject_dispatch(SWO_WRONG_DATA_LENGTH);
            buf = make_buf(cmd);
            return handler_finalize_deploy_and_sign(&buf);

        /* M8 P4 — master-secret reveal. Single-shot, path-only request like
         * GET_PUBLIC_KEY; treat as an L4 boundary and reset any in-flight
         * verified-calls session before handling. */
        case INS_GET_AZTEC_MASTER_SECRET:
            l4_session_reset();
            if (cmd->p1 != 0 || cmd->p2 != 0) {
                return reject_dispatch(SWO_INCORRECT_P1_P2);
            }
            if (!cmd->data) return reject_dispatch(SWO_WRONG_DATA_LENGTH);
            buf = make_buf(cmd);
            return handler_get_aztec_master_secret(&buf);

        default:
            return reject_dispatch(SWO_INVALID_INS);
    }
}
