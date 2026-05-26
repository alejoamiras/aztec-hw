/**
 * Device-side fixed-point decimal formatter for FT amounts.
 *
 * Inputs are: a 32 BE bytes Fr representing a u128 amount, plus a registry-
 * sourced `decimals` (0..30, validated). Output is a "1.500000" / "0.000001" /
 * "1.0" string — always at least one digit after the dot.
 *
 * No FP on the secure element. No host symbols, no host decimals — both come
 * from the on-device registry. Locale-free (no thousands separator).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../l4/wire.h"

/* "340282366920938463463374607431768211455" (u128 max) = 39 chars
 * Plus a decimal point and a possible leading "0." for amounts < 1.
 * Plus a NUL. 48 chars is safe. */
#define CS_FORMAT_MAX_LEN 48u

/**
 * Format a 32-byte BE Fr (interpreted as u128 — bytes 0..15 must be zero or
 * the function returns false) into a decimal string with `decimals` places.
 *
 * @return true on success; false if the high 16 bytes are non-zero (amount
 *         doesn't fit in u128).
 */
bool cs_format_amount(const uint8_t amount_be[L4_FR_BYTES],
                      uint8_t decimals,
                      char *out,
                      size_t out_len);
