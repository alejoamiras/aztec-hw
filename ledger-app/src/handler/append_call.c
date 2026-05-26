#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "os.h"
#include "io.h"
#include "buffer.h"

#include "append_call.h"
#include "../constants.h"
#include "../sw.h"
#include "../l4/fr_canonical.h"
#include "../l4/session.h"
#include "../l4/wire.h"

static int reject(uint16_t sw) {
    l4_session_reset();
    return io_send_sw(sw);
}

/* `function_selector` is a Fr value but the Aztec ABI semantics constrain it
 * to fit in u32 (the high 28 bytes must be exactly zero). Anything outside
 * that range is host fraud — reject before display. */
static bool selector_fits_u32(const uint8_t bytes[L4_FR_BYTES]) {
    for (int i = 0; i < 28; i++) {
        if (bytes[i] != 0) return false;
    }
    return true;
}

int handler_append_call(buffer_t *cdata) {
    if (G_l4_session.state != L4_HEADER_PARSED) return reject(SWO_INVALID_INS);
    if (G_l4_session.calls_received >= G_l4_session.call_count) {
        return reject(SWO_INVALID_INS);
    }

    l4_call_t *slot = &G_l4_session.calls[G_l4_session.calls_received];

    if (!buffer_read_bytes(cdata, slot->args_hash, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(slot->args_hash)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, slot->function_selector, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(slot->function_selector)) return reject(SW_HASH_MISMATCH);
    if (!selector_fits_u32(slot->function_selector)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, slot->target_address, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(slot->target_address)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_u8(cdata, &slot->flags)) return reject(SWO_WRONG_DATA_LENGTH);
    if (slot->flags & ~L4_CALL_FLAG_MASK) return reject(SWO_WRONG_DATA_LENGTH);

    if (cdata->size != cdata->offset) return reject(SWO_WRONG_DATA_LENGTH);

    G_l4_session.calls_received++;
    if (G_l4_session.calls_received == G_l4_session.call_count) {
        G_l4_session.state = L4_CALLS_COMPLETE;
    }

    return io_send_sw(SWO_SUCCESS);
}
