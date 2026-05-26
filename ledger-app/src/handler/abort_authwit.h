#pragma once

#include "buffer.h"

/**
 * ABORT (INS 0x08) — wipe G_l4_session. Idempotent.
 *
 * Body must be empty. Returns SW=9000 always (when body is valid).
 */
int handler_abort_authwit(buffer_t *cdata);
