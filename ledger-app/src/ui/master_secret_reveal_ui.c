/**
 * Master-secret reveal UI (M8 P4) -- NBGL flow for INS_GET_AZTEC_MASTER_SECRET.
 *
 * This is a HIGH-FRICTION reveal: approving discloses permanent note-viewing
 * capability for this account (the host re-derives the 4 viewing keys from the
 * returned secret). It does NOT grant spend authority. The screen wording
 * makes that explicit so a phishing dApp can't pass it off as a routine sign.
 *
 * Two pairs shown:
 *   - Path:    full BIP-32 path (the user confirms WHICH account is exposed)
 *   - Confirm: 4-hex checksum the host also displays, so the user can verify
 *              the device returned the same secret the host received.
 *
 * On approve/reject: routes to master_secret_reveal_approved / _rejected in
 * handler/get_aztec_master_secret.c, which emit the response and dismiss the
 * NBGL page (M6.11 regression guard).
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
#include "../globals.h"
#include "../handler/get_aztec_master_secret.h"

#if defined(TARGET_NANOX) || defined(TARGET_NANOS2)
#define MS_REVEAL_ICON  C_app_aztec_14px
#elif defined(TARGET_STAX) || defined(TARGET_FLEX)
#define MS_REVEAL_ICON  C_app_aztec_64px
#elif defined(TARGET_APEX_P)
#define MS_REVEAL_ICON  C_app_aztec_48px
#else
#define MS_REVEAL_ICON  C_app_aztec_64px
#endif

static char g_path_str[128];
static char g_confirm_str[8];

static nbgl_layoutTagValueList_t g_pair_list;
static nbgl_layoutTagValue_t g_pairs[2];

static bool format_bip32_path(char *out, size_t out_len) {
    if (out_len < 2) return false;
    out[0] = 'm';
    out[1] = '\0';
    size_t cur = 1;
    for (uint8_t i = 0; i < G_context.bip32_path_len; i++) {
        const uint32_t p = G_context.bip32_path[i];
        const uint32_t v = p & 0x7FFFFFFFu;
        const char *suffix = (p & 0x80000000u) ? "'" : "";
        if (cur >= out_len) return false;
        const size_t avail = out_len - cur;
        const int n = snprintf(out + cur, avail, "/%u%s", (unsigned)v, suffix);
        if (n < 0 || (size_t)n >= avail) return false;
        cur += (size_t)n;
    }
    return true;
}

static void on_reveal_choice(bool confirm) {
    if (confirm) {
        master_secret_reveal_approved();
    } else {
        master_secret_reveal_rejected();
    }
}

int ui_display_master_secret_reveal(void) {
    if (!format_bip32_path(g_path_str, sizeof(g_path_str))) {
        return master_secret_reveal_rejected();
    }
    snprintf(g_confirm_str, sizeof(g_confirm_str), "%s", master_secret_checksum_str());

    size_t n = 0;
    g_pairs[n].item = "Path";    g_pairs[n].value = g_path_str;    n++;
    g_pairs[n].item = "Confirm"; g_pairs[n].value = g_confirm_str; n++;

    memset(&g_pair_list, 0, sizeof(g_pair_list));
    g_pair_list.pairs = g_pairs;
    g_pair_list.nbPairs = (uint8_t)n;
    g_pair_list.smallCaseForValue = false;
    g_pair_list.wrapping = true;

    nbgl_useCaseReview(TYPE_OPERATION,
                       &g_pair_list,
                       &MS_REVEAL_ICON,
                       "Reveal Aztec viewing key",
                       "This exposes note visibility, not spending",
                       "Reveal viewing key for this account?",
                       on_reveal_choice);
    return 0;
}
