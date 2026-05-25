#pragma once

#include <stdint.h>

#include "ux.h"

#include "io.h"
#include "types.h"
#include "constants.h"

/**
 * Global context for user requests. Single in-flight session (no session_id
 * in the APDU wire format) per plan-final.md final-critique §3.
 */
extern global_ctx_t G_context;
