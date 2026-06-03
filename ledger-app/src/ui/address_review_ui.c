/**
 * Aztec receive-address review UI (AHW-098, W4) — NBGL flow for INS_GET_AZTEC_ADDRESS.
 *
 * Shows the device-DERIVED account address the user is attesting (for funding /
 * onboarding) so the host can be forced to equality-check its OWN derivation against
 * the device's answer (no host fallback). Three pairs:
 *   - Address: the receive address, 8 leading + 6 trailing hex (56 bits — same scheme
 *     as the deploy review, locked at the M7 approval gate)
 *   - Account: "#N" — the human account index
 *   - Scheme:  ECDSA-K1 / Schnorr (which account flavour the address belongs to)
 *
 * Captures an out-of-band identity snapshot before the review; the approval callback
 * (get_aztec_address.c) returns the address FROM the snapshot and rejects a
 * render→approval glitch (AHW-099-style display binding).
 */
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>

#include "os.h"
#include "nbgl_use_case.h"
#include "glyphs.h"

#include "display.h"
#include "../review_snapshot.h"
#include "../l4/wire.h"
#include "../handler/get_aztec_address.h"

#if defined(TARGET_NANOX) || defined(TARGET_NANOS2)
#define ADDR_REVIEW_ICON  C_app_aztec_14px
#elif defined(TARGET_STAX) || defined(TARGET_FLEX)
#define ADDR_REVIEW_ICON  C_app_aztec_64px
#elif defined(TARGET_APEX_P)
#define ADDR_REVIEW_ICON  C_app_aztec_48px
#else
#define ADDR_REVIEW_ICON  C_app_aztec_64px
#endif

static char g_addr_str[40];
static char g_account_str[16];
static char g_scheme_str[12];

static nbgl_layoutTagValueList_t g_pair_list;
static nbgl_layoutTagValue_t g_pairs[3];

static const char HEX[] = "0123456789abcdef";

static void hex_n(char *out, const uint8_t *bytes, size_t n) {
    for (size_t i = 0; i < n; i++) {
        out[2 * i] = HEX[(bytes[i] >> 4) & 0x0f];
        out[2 * i + 1] = HEX[bytes[i] & 0x0f];
    }
}

/* 8 leading + 6 trailing hex (56 bits) — same scheme + buffer math as deploy_review_ui. */
static void address_8_6(char *out, size_t out_len, const uint8_t bytes[32]) {
    if (out_len < 34) {
        out[0] = '\0';
        return;
    }
    size_t p = 0;
    out[p++] = '0';
    out[p++] = 'x';
    hex_n(out + p, bytes, 8); p += 16;
    out[p++] = '\xE2'; out[p++] = '\x80'; out[p++] = '\xA6'; /* … U+2026 */
    hex_n(out + p, bytes + (32 - 6), 6); p += 12;
    out[p] = '\0';
}

static void on_review_choice(bool confirm) {
    if (confirm) {
        aztec_address_review_approved();
    } else {
        aztec_address_review_rejected();
    }
}

int ui_display_aztec_address_review(void) {
    address_8_6(g_addr_str, sizeof(g_addr_str), aztec_address_bytes());
    snprintf(g_account_str, sizeof(g_account_str), "#%u", (unsigned)aztec_address_account_index());
    snprintf(g_scheme_str, sizeof(g_scheme_str), "%s",
             aztec_address_curve_id() == L4_CURVE_ID_GRUMPKIN ? "Schnorr" : "ECDSA-K1");

    /* AHW-098/099: snapshot the displayed identity (#N + address) out-of-band; the
     * approval callback returns the address FROM this snapshot and rejects on skew. */
    review_snapshot_capture_identity(aztec_address_account_index(), aztec_address_bytes());

    size_t n = 0;
    g_pairs[n].item = "Address"; g_pairs[n].value = g_addr_str;    n++;
    g_pairs[n].item = "Account"; g_pairs[n].value = g_account_str; n++;
    g_pairs[n].item = "Scheme";  g_pairs[n].value = g_scheme_str;  n++;

    memset(&g_pair_list, 0, sizeof(g_pair_list));
    g_pair_list.pairs = g_pairs;
    g_pair_list.nbPairs = (uint8_t)n;
    g_pair_list.smallCaseForValue = false;
    g_pair_list.wrapping = true;

    nbgl_useCaseReview(TYPE_TRANSACTION,
                       &g_pair_list,
                       &ADDR_REVIEW_ICON,
                       "Confirm receive address",
                       "Check this is YOUR Aztec address before funding it.",
                       "Use this Aztec address?",
                       on_review_choice);
    return 0;
}
