/**
 * Verified-calls NBGL review.
 *
 * Per-call structure is split into three separate tag/value pairs so each pair
 * fits inside Nano NBGL's 3-visible-lines-per-value cap (codex L4 MAJOR #3 — see
 * `lib_nbgl/include/nbgl_use_case.h` `NB_MAX_LINES_IN_REVIEW`):
 *
 *   "Call X/N target"   → "0xabcd…1234"
 *   "Call X/N selector" → "0xa9059cbb (2835717307)"
 *   "Call X/N mode"     → "PUBLIC,HIDE_SENDER,STATIC"
 *
 * `args_hash` is deliberately omitted — the deep plan §4 marks it as
 * advanced-detail / larger-screen-only, and the outer_hash binds it cryptographically
 * regardless of whether it's displayed.
 *
 * Review subtitle carries the deep-plan §4 raw-values warning so users can't read
 * "Authorize" without seeing the trust caveat (codex L4 MAJOR #2).
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "os.h"
#include "io.h"
#include "ux.h"
#include "nbgl_use_case.h"

#include "display.h"
#include "../constants.h"
#include "../sw.h"
#include "../l4/session.h"
#include "../l4/wire.h"
#include "../handler/finalize_and_sign.h"

#define REVIEW_TITLE "Authorize Aztec calls"
#define REVIEW_SUBTITLE \
    "INTERNAL build. Addresses and selectors are raw, unverified values."

#if defined(TARGET_NANOX) || defined(TARGET_NANOS2)
#define REVIEW_ICON_VC C_app_aztec_14px
#elif defined(TARGET_STAX) || defined(TARGET_FLEX)
#define REVIEW_ICON_VC C_app_aztec_64px
#elif defined(TARGET_APEX_P)
#define REVIEW_ICON_VC C_app_aztec_48px
#else
#define REVIEW_ICON_VC C_app_aztec_64px
#endif

/* Header pairs (Path, Account, Chain, Calls) + per-call × 3 (target/selector/mode)
 * + outer_hash. With L4_MAX_CALLS=5: 4 + 15 + 1 = 20 pairs. */
#define VC_PAIR_CAPACITY (4u + 3u * L4_MAX_CALLS + 1u)

static char g_path_str[160];
static char g_account_str[80];
static char g_chain_str[80];
static char g_calls_count_str[16];
static char g_call_target[L4_MAX_CALLS][32];
static char g_call_selector[L4_MAX_CALLS][48];
static char g_call_mode[L4_MAX_CALLS][48];
static char g_call_label_target[L4_MAX_CALLS][24];
static char g_call_label_selector[L4_MAX_CALLS][24];
static char g_call_label_mode[L4_MAX_CALLS][24];
static char g_outer_str[80];

static nbgl_contentTagValue_t g_pairs[VC_PAIR_CAPACITY];
static nbgl_contentTagValueList_t g_pair_list;

static const char HEX[] = "0123456789abcdef";

static void hex_n(char *out, const uint8_t *bytes, size_t n) {
    for (size_t i = 0; i < n; i++) {
        out[2 * i] = HEX[(bytes[i] >> 4) & 0x0f];
        out[2 * i + 1] = HEX[bytes[i] & 0x0f];
    }
    out[2 * n] = '\0';
}

/* "0xABCD…1234" — print first 4 + last 4 bytes of a 32-byte field. */
static void short_hex_field(char *out, size_t out_len, const uint8_t bytes[32]) {
    if (out_len < 24) {
        out[0] = '\0';
        return;
    }
    out[0] = '0';
    out[1] = 'x';
    hex_n(out + 2, bytes, 4);
    out[10] = '\xE2'; /* … = U+2026 (UTF-8: e2 80 a6) */
    out[11] = '\x80';
    out[12] = '\xA6';
    hex_n(out + 13, bytes + 28, 4);
}

/* If high 28 bytes are zero, show "0xXXXXXXXX (N)". Otherwise short_hex. */
static void fr_as_u32_or_hex(char *out, size_t out_len, const uint8_t bytes[32]) {
    bool fits = true;
    for (int i = 0; i < 28; i++) {
        if (bytes[i] != 0) { fits = false; break; }
    }
    if (fits) {
        unsigned v = ((unsigned)bytes[28] << 24) | ((unsigned)bytes[29] << 16) |
                     ((unsigned)bytes[30] << 8) | (unsigned)bytes[31];
        snprintf(out, out_len, "0x%08x (%u)", v, v);
    } else {
        short_hex_field(out, out_len, bytes);
    }
}

static bool format_bip32_path(char *out, size_t out_len) {
    if (out_len < 2) return false;
    out[0] = 'm';
    out[1] = '\0';
    size_t cur = 1;
    for (size_t i = 0; i < G_l4_session.bip32_path_len; i++) {
        const uint32_t p = G_l4_session.bip32_path[i];
        const uint32_t v = p & 0x7FFFFFFFu;
        const char *suffix = (p & 0x80000000u) ? "'" : "";
        if (cur >= out_len) return false;
        const size_t avail = out_len - cur;
        const int n = snprintf(out + cur, avail, "/%u%s", (unsigned)v, suffix);
        if (n < 0) return false;
        if ((size_t)n >= avail) return false;
        cur += (size_t)n;
    }
    return true;
}

/* Compose mode string from flag bits. Compact for narrow screens. */
static void format_mode(char *out, size_t out_len, uint8_t flags) {
    bool first = true;
    out[0] = '\0';
    size_t cur = 0;
    const char *parts[] = {
        (flags & L4_CALL_FLAG_PUBLIC) ? "PUBLIC" : "PRIVATE",
        (flags & L4_CALL_FLAG_STATIC) ? "STATIC" : NULL,
        (flags & L4_CALL_FLAG_HIDE_MSG_SENDER) ? "HIDE_SENDER" : NULL,
    };
    for (size_t i = 0; i < 3; i++) {
        if (parts[i] == NULL) continue;
        const char *sep = first ? "" : ",";
        int n = snprintf(out + cur, (cur < out_len) ? (out_len - cur) : 0,
                         "%s%s", sep, parts[i]);
        if (n < 0) break;
        cur += (size_t)n;
        first = false;
    }
}

static void on_review_choice(bool confirm) {
    if (confirm) {
        finalize_after_approval();
    } else {
        finalize_rejected();
    }
}

int ui_display_verified_calls(void) {
    if (!format_bip32_path(g_path_str, sizeof(g_path_str))) {
        return finalize_rejected();
    }
    short_hex_field(g_account_str, sizeof(g_account_str), G_l4_session.consumer);
    fr_as_u32_or_hex(g_chain_str, sizeof(g_chain_str), G_l4_session.chain_id);
    snprintf(g_calls_count_str, sizeof(g_calls_count_str), "%u",
             (unsigned)G_l4_session.call_count);
    short_hex_field(g_outer_str, sizeof(g_outer_str), G_l4_session.outer_hash);

    size_t n_pairs = 0;
    g_pairs[n_pairs].item = "Path";
    g_pairs[n_pairs].value = g_path_str;
    n_pairs++;
    g_pairs[n_pairs].item = "Account";
    g_pairs[n_pairs].value = g_account_str;
    n_pairs++;
    g_pairs[n_pairs].item = "Chain";
    g_pairs[n_pairs].value = g_chain_str;
    n_pairs++;
    g_pairs[n_pairs].item = "Calls";
    g_pairs[n_pairs].value = g_calls_count_str;
    n_pairs++;

    for (uint8_t i = 0; i < G_l4_session.call_count && n_pairs + 3 <= VC_PAIR_CAPACITY; i++) {
        l4_call_t *c = &G_l4_session.calls[i];

        snprintf(g_call_label_target[i], sizeof(g_call_label_target[i]),
                 "Call %u/%u target", (unsigned)(i + 1), (unsigned)G_l4_session.call_count);
        snprintf(g_call_label_selector[i], sizeof(g_call_label_selector[i]),
                 "Call %u/%u selector", (unsigned)(i + 1), (unsigned)G_l4_session.call_count);
        snprintf(g_call_label_mode[i], sizeof(g_call_label_mode[i]),
                 "Call %u/%u mode", (unsigned)(i + 1), (unsigned)G_l4_session.call_count);

        short_hex_field(g_call_target[i], sizeof(g_call_target[i]), c->target_address);
        fr_as_u32_or_hex(g_call_selector[i], sizeof(g_call_selector[i]), c->function_selector);
        format_mode(g_call_mode[i], sizeof(g_call_mode[i]), c->flags);

        g_pairs[n_pairs].item = g_call_label_target[i];
        g_pairs[n_pairs].value = g_call_target[i];
        n_pairs++;
        g_pairs[n_pairs].item = g_call_label_selector[i];
        g_pairs[n_pairs].value = g_call_selector[i];
        n_pairs++;
        g_pairs[n_pairs].item = g_call_label_mode[i];
        g_pairs[n_pairs].value = g_call_mode[i];
        n_pairs++;
    }

    g_pairs[n_pairs].item = "outer_hash";
    g_pairs[n_pairs].value = g_outer_str;
    n_pairs++;

    memset(&g_pair_list, 0, sizeof(g_pair_list));
    g_pair_list.pairs = g_pairs;
    g_pair_list.nbPairs = (uint8_t)n_pairs;
    g_pair_list.smallCaseForValue = false;
    g_pair_list.wrapping = true;

    nbgl_useCaseReview(TYPE_TRANSACTION,
                       &g_pair_list,
                       &REVIEW_ICON_VC,
                       REVIEW_TITLE,
                       REVIEW_SUBTITLE,
                       "Sign Aztec authorization?",
                       on_review_choice);
    return 0;
}
