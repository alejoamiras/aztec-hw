/**
 * NBGL-based on-device confirmation UI for the Aztec K1 sign flow.
 *
 * Shows: "Aztec authorization (INTERNAL — DO NOT SHIP)" banner per upstream H4.
 * The L2 blind-sign UX displays the BIP-32 path + the outer_hash hex prefix.
 * The full clear-signing UI (L4) replaces this with structured intent fields.
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "os.h"
#include "io.h"
#include "ux.h"
#include "nbgl_use_case.h"

#include "display.h"
#include "../globals.h"
#include "../sw.h"
#include "../handler/sign_outer_hash.h"

#define BANNER_TEXT "Aztec authorization"
#define WARNING_TEXT "INTERNAL build - do NOT use to sign real Aztec calls."

/**
 * Pick the right glyph for the active target. Nano screens are tiny — the 64px
 * icon won't fit; use the 14px one. Stax/Flex/Apex use larger glyphs.
 */
#if defined(TARGET_NANOX) || defined(TARGET_NANOS2)
#define REVIEW_ICON C_app_aztec_14px
#elif defined(TARGET_STAX) || defined(TARGET_FLEX)
#define REVIEW_ICON C_app_aztec_64px
#elif defined(TARGET_APEX_P)
#define REVIEW_ICON C_app_aztec_48px
#else
#define REVIEW_ICON C_app_aztec_64px
#endif

// Sized for the maximum BIP-32 path we accept (MAX_BIP32_PATH_LEN=10) at "m" + 10 * "/4294967295'" + NUL
// = 1 + 10*12 + 1 = 122 bytes. Round up to 160 for safety; truncation is now reported as an error
// rather than silently shown (codex L2 BLOCKER #1).
static char g_path_str[160];
static char g_hash_hex[2 * 32 + 1];

static nbgl_contentTagValue_t g_review_pairs[2];
static nbgl_contentTagValueList_t g_review_list;

static void on_review_choice(bool confirm) {
    if (confirm) {
        sign_outer_hash_after_approval();
    } else {
        sign_outer_hash_rejected();
    }
}

/**
 * Format the path. Returns true on success, false if it didn't fit (caller must abort).
 *
 * NB: BOLOS's `snprintf` (`os_printf.c`) does NOT support `%lu` by default — the `%l` branch
 * is guarded by `HAVE_SNPRINTF_FORMAT_LL` and falls through to `-1` otherwise. We use `%u`
 * with a `(unsigned) v` cast; values are masked to 31 bits before this point so the cast is
 * lossless on Cortex-M (int is 32-bit).
 */
static bool format_bip32_path(char *out, size_t out_len) {
    if (out_len < 2) return false;
    out[0] = 'm';
    out[1] = '\0';
    size_t cur = 1;
    for (size_t i = 0; i < G_context.bip32_path_len; i++) {
        const uint32_t p = G_context.bip32_path[i];
        const uint32_t v = p & 0x7FFFFFFFu;
        const char *suffix = (p & 0x80000000u) ? "'" : "";
        if (cur >= out_len) return false;
        const size_t avail = out_len - cur;
        const int n = snprintf(out + cur, avail, "/%u%s", (unsigned) v, suffix);
        if (n < 0) return false;
        if ((size_t) n >= avail) return false;
        cur += (size_t) n;
    }
    return true;
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
    // Refuse to sign if we cannot show the user the full path they're authorizing
    // (codex L2 BLOCKER #1 — no silent UI truncation on security-critical surface).
    if (!format_bip32_path(g_path_str, sizeof(g_path_str))) {
        return sign_outer_hash_rejected();
    }
    format_hash_hex(g_hash_hex, sizeof(g_hash_hex), G_context.sign_info.outer_hash, 32);

    memset(&g_review_pairs, 0, sizeof(g_review_pairs));
    g_review_pairs[0].item = "Path";
    g_review_pairs[0].value = g_path_str;
    g_review_pairs[1].item = "outer_hash";
    g_review_pairs[1].value = g_hash_hex;

    memset(&g_review_list, 0, sizeof(g_review_list));
    g_review_list.pairs = g_review_pairs;
    g_review_list.nbPairs = 2;
    g_review_list.smallCaseForValue = false;
    g_review_list.wrapping = true;

    nbgl_useCaseReviewBlindSigning(TYPE_TRANSACTION,
                                   &g_review_list,
                                   &REVIEW_ICON,
                                   BANNER_TEXT,
                                   WARNING_TEXT,
                                   "Sign Aztec outer_hash?",
                                   NULL,
                                   on_review_choice);
    return 0;
}

int ui_display_pubkey(void) {
    // L2 baseline does not gate pubkey export behind a UI confirmation. L4
    // adds an opt-in display flow. For now, this is unreachable.
    return 0;
}
