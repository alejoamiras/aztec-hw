/**
 * NBGL-based on-device confirmation UI for the Aztec K1 sign flow.
 *
 * Shows: "Aztec authorization (INTERNAL — DO NOT SHIP)" banner per upstream H4.
 * The L2 blind-sign UX displays the BIP-32 path + the outer_hash hex prefix.
 * The full clear-signing UI (L4) replaces this with structured intent fields.
 */

#include <stdint.h>
#include <string.h>

#include "os.h"
#include "io.h"
#include "ux.h"
#include "nbgl_use_case.h"

#include "display.h"
#include "../globals.h"
#include "../sw.h"
#include "../handler/sign_outer_hash.h"

#define BANNER_TEXT "Aztec authorization\nINTERNAL — DO NOT SHIP"

static char g_path_str[80];
static char g_hash_hex[2 * 32 + 1];

static const nbgl_contentTagValue_t g_review_pairs[] = {
    {.item = "Path", .value = g_path_str},
    {.item = "outer_hash", .value = g_hash_hex},
};

static const nbgl_contentTagValueList_t g_review_list = {
    .pairs = g_review_pairs,
    .nbPairs = 2,
};

static void on_review_choice(bool confirm) {
    if (confirm) {
        sign_outer_hash_after_approval();
    } else {
        sign_outer_hash_rejected();
    }
}

static void format_bip32_path(char *out, size_t out_len) {
    out[0] = 'm';
    size_t cur = 1;
    for (size_t i = 0; i < G_context.bip32_path_len; i++) {
        const uint32_t p = G_context.bip32_path[i];
        const uint32_t v = p & 0x7FFFFFFFu;
        const char *suffix = (p & 0x80000000u) ? "'" : "";
        int n = snprintf(out + cur, out_len - cur, "/%lu%s", (unsigned long) v, suffix);
        if (n < 0 || (size_t) n >= out_len - cur) break;
        cur += (size_t) n;
    }
}

static void format_hash_hex(char *out, size_t out_len, const uint8_t *bytes, size_t bytes_len) {
    static const char hex[] = "0123456789abcdef";
    if (out_len < 2 * bytes_len + 1) return;
    for (size_t i = 0; i < bytes_len; i++) {
        out[2 * i] = hex[(bytes[i] >> 4) & 0x0f];
        out[2 * i + 1] = hex[bytes[i] & 0x0f];
    }
    out[2 * bytes_len] = '\0';
}

int ui_display_blind_sign(void) {
    format_bip32_path(g_path_str, sizeof(g_path_str));
    format_hash_hex(g_hash_hex, sizeof(g_hash_hex), G_context.sign_info.outer_hash, 32);

    nbgl_useCaseReview(TYPE_OPERATION,
                       &g_review_list,
                       &C_app_aztec_64px,
                       BANNER_TEXT,
                       NULL,
                       "Sign Aztec outer_hash",
                       on_review_choice);
    return 0;
}

int ui_display_pubkey(void) {
    // Minimal confirmation — show path, accept/reject.
    format_bip32_path(g_path_str, sizeof(g_path_str));
    // Reuse the review pair list with just the path entry.
    static const nbgl_contentTagValue_t pubkey_pair = {.item = "Path", .value = g_path_str};
    static const nbgl_contentTagValueList_t pubkey_list = {.pairs = &pubkey_pair, .nbPairs = 1};

    nbgl_useCaseReview(TYPE_OPERATION,
                       &pubkey_list,
                       &C_app_aztec_64px,
                       "Aztec public key",
                       NULL,
                       "Approve key display",
                       on_review_choice);
    return 0;
}
