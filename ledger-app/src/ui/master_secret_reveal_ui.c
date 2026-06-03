/**
 * Master-secret reveal UI (M8 P4) -- NBGL flow for INS_GET_AZTEC_MASTER_SECRET.
 *
 * This is a HIGH-FRICTION reveal: approving exports this account's PRIVACY ROOT —
 * the one secret from which the host derives ALL four viewing keys (NHK/IVSK/OVSK/
 * TSK). It is chainId-independent and shared across both signing schemes at this
 * path, so it lets the host see this account's notes on EVERY network (AHW-047). It
 * does NOT grant spend authority (the spend key never leaves the device). The
 * wording is blunt so a phishing dApp can't pass it off as a routine sign.
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
#include "../review_snapshot.h"
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

static char g_account_str[16];  /* M9 B2: "#N" — the human account index, not the path. */
static char g_confirm_str[8];

static nbgl_layoutTagValueList_t g_pair_list;
static nbgl_layoutTagValue_t g_pairs[2];

/* M9 B2: the human account index — the hardened account component of
 * m/44'/AZTEC'/<account>'/0/0 (component 2). */
static uint32_t reveal_account_index(void) {
    return (G_context.bip32_path_len > 2) ? (G_context.bip32_path[2] & 0x7FFFFFFFu) : 0;
}

static void on_reveal_choice(bool confirm) {
    if (confirm) {
        master_secret_reveal_approved();
    } else {
        master_secret_reveal_rejected();
    }
}

int ui_display_master_secret_reveal(void) {
    /* M9 B2: show "Account #N" (the human index) instead of the BIP-32 path. */
    snprintf(g_account_str, sizeof(g_account_str), "#%u", (unsigned)reveal_account_index());
    snprintf(g_confirm_str, sizeof(g_confirm_str), "%s", master_secret_checksum_str());

    size_t n = 0;
    g_pairs[n].item = "Account"; g_pairs[n].value = g_account_str; n++;
    g_pairs[n].item = "Confirm"; g_pairs[n].value = g_confirm_str; n++;

    memset(&g_pair_list, 0, sizeof(g_pair_list));
    g_pair_list.pairs = g_pairs;
    g_pair_list.nbPairs = (uint8_t)n;
    g_pair_list.smallCaseForValue = false;
    g_pair_list.wrapping = true;

    /* AHW-112 (W1 sibling): snapshot the displayed account index out-of-band; the
     * approval handler verifies the live #N matches before exporting the privacy
     * root, so a render→approval path glitch can't reveal a different account's
     * secret than the one shown. Reveal has no address pair → NULL address. */
    review_snapshot_capture_identity(reveal_account_index(), NULL);

    /* Codex Phase-4 review MAJOR: TYPE_TRANSACTION is the proven review type
     * used elsewhere in the app; TYPE_OPERATION was unverified for this SDK. */
    nbgl_useCaseReview(TYPE_TRANSACTION,
                       &g_pair_list,
                       &MS_REVEAL_ICON,
                       "Reveal privacy root",
                       "Lets this computer see ALL this account's notes, on every network. Not spending.",
                       "Reveal this account's privacy root?",
                       on_reveal_choice);
    return 0;
}
