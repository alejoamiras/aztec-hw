/**
 * Aztec Ledger app — main APDU loop.
 *
 * Stripped from app-boilerplate to drop SWAP / dynamic-token / NVM bookkeeping
 * we don't need for L2 K1 baseline.
 */

#include <stdint.h>
#include <string.h>

#include "os.h"
#include "ux.h"

#include "types.h"
#include "globals.h"
#include "io.h"
#include "sw.h"
#include "ui/menu.h"
#include "apdu/dispatcher.h"
#include "l4/session.h"

global_ctx_t G_context;

void app_main(void) {
    int input_len = 0;
    command_t cmd;

    io_init();
    ui_menu_main();

    // Reset context on app start
    explicit_bzero(&G_context, sizeof(G_context));

    for (;;) {
        if ((input_len = io_recv_command()) < 0) {
            PRINTF("=> io_recv_command failure\n");
            return;
        }

        if (!apdu_parser(&cmd, G_io_apdu_buffer, input_len)) {
            PRINTF("=> /!\\ BAD LENGTH: %.*H\n", input_len, G_io_apdu_buffer);
            io_send_sw(SWO_WRONG_DATA_LENGTH);
            // Zeroize any partial session state (final critique §9). AHW-017: a parse
            // failure short-circuits BEFORE the dispatcher, so also reset the L4
            // sessions here to honor the "any non-0x9000 path zeroes the L4 session"
            // invariant (l4_session_reset also disarms the reveal secret — AHW-059).
            explicit_bzero(&G_context, sizeof(G_context));
            l4_session_reset();
            continue;
        }

        PRINTF("=> CLA=%02X | INS=%02X | P1=%02X | P2=%02X | Lc=%02X\n",
               cmd.cla, cmd.ins, cmd.p1, cmd.p2, cmd.lc);

        if (apdu_dispatcher(&cmd) < 0) {
            PRINTF("=> apdu_dispatcher failure\n");
            // Zeroize on any non-success exit.
            explicit_bzero(&G_context, sizeof(G_context));
            return;
        }
    }
}
