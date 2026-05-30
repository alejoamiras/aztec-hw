/**
 * Deploy account review UI (M7 P3) — NBGL flow for the clear-signed
 * deploy. Three pairs visible on the review screen:
 *
 *   - Address: 8 leading + 6 trailing hex (56 bits — codex+opus agreed,
 *     locked at approval gate; 6+4 was 40 bits / brute-forceable)
 *   - Account: "#N" — the human account index (M9 B1; was the BIP-32 path)
 *   - Fee:     "Sponsored (testnet)"
 *
 * Pubkey fingerprint + class-id were deliberately dropped at approval
 * gate (user picked the minimal triplet). The synthesized canonical
 * call list (init payload + sponsor payload) is fully determined by
 * BEGIN_DEPLOY_ACCOUNT inputs — see codex audit MAJOR #1.
 *
 * On approve/reject: nbgl_useCaseReviewStatus(... ui_menu_main) ships
 * from commit zero (M6.11 regression guard).
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
#include "../l4/session.h"
#include "../handler/finalize_deploy_and_sign.h"

#if defined(TARGET_NANOX) || defined(TARGET_NANOS2)
#define DEPLOY_REVIEW_ICON  C_app_aztec_14px
#elif defined(TARGET_STAX) || defined(TARGET_FLEX)
#define DEPLOY_REVIEW_ICON  C_app_aztec_64px
#elif defined(TARGET_APEX_P)
#define DEPLOY_REVIEW_ICON  C_app_aztec_48px
#else
#define DEPLOY_REVIEW_ICON  C_app_aztec_64px
#endif

/* address_8_6 emits "0x"(2) + 16 hex (8 bytes) + "…"(3 UTF-8) + 12 hex (6 bytes) +
 * NUL = 34 bytes. The old [32] was too small, so address_8_6's length guard wrote
 * "" and the deploy review showed NO address — defeating the clear-signing gate
 * (codex P9 BLOCKER). 40 gives headroom. */
static char g_addr_str[40];
static char g_account_str[16];  /* M9 B1: "#N" — the human account index, not the BIP-32 path. */
static char g_fee_str[40];

static nbgl_layoutTagValueList_t g_pair_list;
static nbgl_layoutTagValue_t g_pairs[4];

static const char HEX[] = "0123456789abcdef";

static void hex_n(char *out, const uint8_t *bytes, size_t n) {
    for (size_t i = 0; i < n; i++) {
        out[2 * i] = HEX[(bytes[i] >> 4) & 0x0f];
        out[2 * i + 1] = HEX[bytes[i] & 0x0f];
    }
}

/** 8 leading + 6 trailing hex characters (56 bits) — locked at M7
 * approval gate. NBGL's tag-value pair clips short strings on small
 * screens; the visible portion still gives the user 56 bits to spot
 * vanity-brute-force. */
static void address_8_6(char *out, size_t out_len, const uint8_t bytes[32]) {
    /* "0x" + 16 + "…" (3 UTF-8 bytes) + 12 + NUL = 34 — needs out_len >= 34. */
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

/* M9 B1: the human account index — the hardened account component of
 * m/44'/AZTEC'/<account>'/0/0 (component 2). The user thinks "Account #N",
 * not in BIP-32 paths. */
static uint32_t deploy_account_index(void) {
    return (G_l4_deploy_session.bip32_path_len > 2)
               ? (G_l4_deploy_session.bip32_path[2] & 0x7FFFFFFFu)
               : 0;
}

static void on_review_choice(bool confirm) {
    if (confirm) {
        finalize_deploy_after_approval();
    } else {
        finalize_deploy_rejected();
    }
}

int ui_display_deploy_review(void) {
    /* M9 B1: show "Account #N" instead of the BIP-32 path. */
    snprintf(g_account_str, sizeof(g_account_str), "#%u", (unsigned)deploy_account_index());
    /* M8 P6 (codex trap #1): display the DEVICE-derived + verified address
     * (address_local), NOT the host-claimed expected_address. BEGIN already
     * proved they're equal; showing the device-authored value means the user
     * approves what the device computed, not what the host asserted. */
    address_8_6(g_addr_str, sizeof(g_addr_str), G_l4_deploy_session.address_local);
    /* Profile-pinned fee semantics; v0 only supports sponsored deploys. */
    snprintf(g_fee_str, sizeof(g_fee_str), "Sponsored (testnet)");

    size_t n = 0;
    g_pairs[n].item = "Address"; g_pairs[n].value = g_addr_str;    n++;
    g_pairs[n].item = "Account"; g_pairs[n].value = g_account_str; n++;
    g_pairs[n].item = "Fee";     g_pairs[n].value = g_fee_str;     n++;

    memset(&g_pair_list, 0, sizeof(g_pair_list));
    g_pair_list.pairs = g_pairs;
    g_pair_list.nbPairs = (uint8_t)n;
    g_pair_list.smallCaseForValue = false;
    g_pair_list.wrapping = true;

    nbgl_useCaseReview(TYPE_TRANSACTION,
                       &g_pair_list,
                       &DEPLOY_REVIEW_ICON,
                       "Deploy Aztec account",
                       "Review and approve",
                       "Deploy your Aztec account?",
                       on_review_choice);
    return 0;
}
