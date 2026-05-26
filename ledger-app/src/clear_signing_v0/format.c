#include <string.h>

#include "format.h"

/* Fixed-point divide-by-10 over a u128 stored as 16 bytes BE. Updates `digits`
 * (16 bytes BE) in place and returns the remainder digit 0..9.
 * Used to produce the decimal string from least significant to most. */
static uint8_t u128_divmod10_be(uint8_t digits[16]) {
    uint32_t rem = 0;
    for (int i = 0; i < 16; i++) {
        uint32_t cur = (rem << 8) | digits[i];
        digits[i] = (uint8_t)(cur / 10u);
        rem = cur % 10u;
    }
    return (uint8_t)rem;
}

static bool u128_is_zero(const uint8_t digits[16]) {
    for (int i = 0; i < 16; i++) if (digits[i] != 0) return false;
    return true;
}

bool cs_format_amount(const uint8_t amount_be[L4_FR_BYTES],
                      uint8_t decimals,
                      char *out,
                      size_t out_len) {
    if (out == NULL || out_len == 0) return false;
    out[0] = '\0';

    /* The high 16 bytes of a Fr-encoded u128 must be zero. */
    for (int i = 0; i < 16; i++) {
        if (amount_be[i] != 0) return false;
    }
    if (decimals > 30u) return false;

    /* Extract digits least-significant-first. Worst case = 39 digits for u128 max. */
    uint8_t u128[16];
    memcpy(u128, amount_be + 16, 16);

    char digits[40];
    size_t digit_count = 0;
    if (u128_is_zero(u128)) {
        digits[digit_count++] = '0';
    } else {
        while (!u128_is_zero(u128)) {
            uint8_t d = u128_divmod10_be(u128);
            digits[digit_count++] = (char)('0' + d);
        }
    }

    /* Format as `whole.frac`. We have digit_count digits; the last `decimals` of
     * them are the fractional part (with leading zeros if digit_count < decimals).
     *
     * Examples (decimals=6):
     *   digits=[5,1] (== 15)  → "0.000015"
     *   digits=[0,0,0,0,0,0,1] (== 1000000) → "1.0"
     *   digits=[0,1,1] (== 110) → "0.00011"   (one leading zero, two from
     *                                          significand, trailing zero trimmed)
     */
    size_t pos = 0;
    size_t need_room = 0; /* worst-case length estimate (for overflow check) */
    if (decimals == 0) {
        need_room = digit_count + 3 /* ".0\0" */;
    } else {
        need_room = (digit_count > decimals ? digit_count : decimals) + 3;
    }
    if (out_len < need_room) {
        out[0] = '\0';
        return false;
    }

    if (decimals == 0) {
        /* Just print digits + ".0". */
        for (size_t i = 0; i < digit_count; i++) {
            out[pos++] = digits[digit_count - 1 - i];
        }
        out[pos++] = '.';
        out[pos++] = '0';
        out[pos] = '\0';
        return true;
    }

    /* Whole part. */
    if (digit_count > decimals) {
        size_t whole_count = digit_count - decimals;
        for (size_t i = 0; i < whole_count; i++) {
            out[pos++] = digits[digit_count - 1 - i];
        }
    } else {
        out[pos++] = '0';
    }
    out[pos++] = '.';

    /* Fractional part: left-pad with zeros up to `decimals` digits. */
    size_t frac_digits = (digit_count > decimals) ? decimals : digit_count;
    size_t leading_zeros = (digit_count > decimals) ? 0 : (decimals - digit_count);
    for (size_t i = 0; i < leading_zeros; i++) out[pos++] = '0';
    for (size_t i = 0; i < frac_digits; i++) {
        out[pos++] = digits[frac_digits - 1 - i];
    }

    /* Trim trailing zeros from the fractional part, but always leave at least
     * one digit after the dot ("1.0", never "1."). */
    size_t dot_pos = pos - (leading_zeros + frac_digits) - 1;
    while (pos > dot_pos + 2 && out[pos - 1] == '0') {
        pos--;
    }
    out[pos] = '\0';
    return true;
}
