/**
 * BN254 Fr canonical-encoding check — shared between L4 handlers.
 *
 * Both `begin_authwit.c` and `append_call.c` previously open-coded the same
 * 32-byte BE compare against the field prime; codex L4 MINOR called out the
 * duplication. This header centralizes the check.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "wire.h"

/** Returns true iff `bytes` < p (i.e. is a canonical BN254 Fr encoding). */
bool l4_fr_is_canonical(const uint8_t bytes[L4_FR_BYTES]);
