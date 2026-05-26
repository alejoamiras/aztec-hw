#include <stdint.h>

#include "io.h"
#include "buffer.h"

#include "abort_authwit.h"
#include "../sw.h"
#include "../l4/session.h"

int handler_abort_authwit(buffer_t *cdata) {
    if (cdata->size != cdata->offset) {
        l4_session_reset();
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    l4_session_reset();
    return io_send_sw(SWO_SUCCESS);
}
