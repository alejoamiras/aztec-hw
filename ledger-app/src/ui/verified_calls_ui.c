/**
 * Clear-signing v0 (M5.3): verified-calls NBGL review with decoded FT semantics.
 *
 * Per-call rendering driven by the on-device registry + verb decoder. Strict
 * allowlist already enforced at APPEND_CALL time (M5.2), so by the time we
 * reach this code every call is guaranteed to:
 *   - match a registry slot (kind ∈ {TOKEN, SPONSOR})
 *   - match a verb in CS_VERBS (selector + arg_count + visibility checked)
 *   - have raw args populated in G_l4_session.calls[i].args
 *
 * UI templates:
 *   TRANSFER_*  → Action label + From + To + Amount (decimals from registry) + Mode
 *   MINT_*      → "⚠ MINTER ACTION" warning + Action label + To + Amount
 *   SPONSOR     → "Sponsor fee (private)" + "Via: testnet FPC"
 *
 * The outer_hash pair stays at the tail (defense in depth for paranoid users).
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
#include "../clear_signing_v0/format.h"
#include "../clear_signing_v0/registry.gen.h"
#include "../clear_signing_v0/selectors.gen.h"
#include "../handler/finalize_and_sign.h"

#define REVIEW_TITLE "Authorize Aztec calls"
#define REVIEW_SUBTITLE \
    "INTERNAL build. Verified against on-device registry."

#if defined(TARGET_NANOX) || defined(TARGET_NANOS2)
#define REVIEW_ICON_VC C_app_aztec_14px
#elif defined(TARGET_STAX) || defined(TARGET_FLEX)
#define REVIEW_ICON_VC C_app_aztec_64px
#elif defined(TARGET_APEX_P)
#define REVIEW_ICON_VC C_app_aztec_48px
#else
#define REVIEW_ICON_VC C_app_aztec_64px
#endif

/* Worst-case pair count: 4 headers + 5 calls × 5 (TRANSFER) + 1 outer_hash = 30. */
#define VC_PAIR_CAPACITY 32u

/* Static label/value string pools. RAM cost ~4 KB. */
static char g_path_str[160];
static char g_account_str[80];
static char g_chain_str[80];
static char g_calls_count_str[16];
static char g_outer_str[80];

/* Per-call buffers — 5 max calls × per-pair strings. */
static char g_call_label[L4_MAX_CALLS][24];           /* "Call 1/3" */
static char g_call_action[L4_MAX_CALLS][48];          /* "Transfer USDC pub→pub" */
static char g_call_from[L4_MAX_CALLS][24];            /* truncated address or "you" */
static char g_call_to[L4_MAX_CALLS][24];
static char g_call_amount[L4_MAX_CALLS][CS_FORMAT_MAX_LEN + 16]; /* "1.500000 USDC" */
static char g_call_mode[L4_MAX_CALLS][32];
static char g_call_via[L4_MAX_CALLS][48];

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

static void short_hex_field(char *out, size_t out_len, const uint8_t bytes[32]) {
    if (out_len < 24) {
        out[0] = '\0';
        return;
    }
    out[0] = '0';
    out[1] = 'x';
    hex_n(out + 2, bytes, 4);
    out[10] = '\xE2'; /* … = U+2026 */
    out[11] = '\x80';
    out[12] = '\xA6';
    hex_n(out + 13, bytes + 28, 4);
}

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

/* Map verb_id → human-readable action label using the registry's symbol. */
static void format_action(char *out, size_t out_len, uint8_t verb_id, const char *symbol) {
    /* ASCII-only labels — nano S+ NBGL font lacks U+2192 (→) and other Unicode
     * glyphs; non-ASCII falls back to substitution chars on-screen. */
    const char *base = "Call";
    switch (verb_id) {
        case CS_VERB_TRANSFER_PRIV_PUB:  base = "Transfer priv->pub"; break;
        case CS_VERB_TRANSFER_PRIV_PRIV: base = "Transfer priv->priv"; break;
        case CS_VERB_TRANSFER_PUB_PRIV:  base = "Transfer pub->priv"; break;
        case CS_VERB_TRANSFER_PUB_PUB:   base = "Transfer pub->pub"; break;
        case CS_VERB_MINT_PUB:           base = "Mint public"; break;
        case CS_VERB_MINT_PRIV:          base = "Mint private"; break;
        case CS_VERB_SPONSOR:            base = "Sponsor fee"; break;
        default: break;
    }
    if (symbol && symbol[0] != '\0') {
        snprintf(out, out_len, "%s %s", base, symbol);
    } else {
        snprintf(out, out_len, "%s", base);
    }
}

/* "you" if the 32B address equals G_l4_session.consumer, else short hex. */
static void format_from(char *out, size_t out_len, const uint8_t addr[32]) {
    if (memcmp(addr, G_l4_session.consumer, 32) == 0) {
        snprintf(out, out_len, "you");
    } else {
        short_hex_field(out, out_len, addr);
    }
}

static void on_review_choice(bool confirm) {
    if (confirm) {
        finalize_after_approval();
    } else {
        finalize_rejected();
    }
}

static uint32_t selector_u32_from_be(const uint8_t bytes[L4_FR_BYTES]) {
    return ((uint32_t)bytes[28] << 24)
         | ((uint32_t)bytes[29] << 16)
         | ((uint32_t)bytes[30] << 8)
         | (uint32_t)bytes[31];
}

/* Render one call into its slot of the per-call buffers and return how many
 * tag-value pairs were added. */
static size_t render_call_pairs(uint8_t i, size_t out_idx) {
    l4_call_t *c = &G_l4_session.calls[i];
    const cs_registry_entry_t *reg = cs_registry_lookup(c->target_address);
    /* M5.2 enforced reg != NULL at APPEND_CALL time; defense-in-depth check. */
    if (reg == NULL) return 0;
    uint32_t sel_u32 = selector_u32_from_be(c->function_selector);
    const cs_verb_entry_t *verb = cs_verb_lookup(reg->kind, sel_u32);
    if (verb == NULL) return 0;

    /* Call label: "Call 1/3". */
    snprintf(g_call_label[i], sizeof(g_call_label[i]),
             "Call %u/%u", (unsigned)(i + 1), (unsigned)G_l4_session.call_count);
    /* Action: "Transfer USDC pub→pub" / "Mint USDC public" / "Sponsor fee". */
    format_action(g_call_action[i], sizeof(g_call_action[i]), verb->verb, reg->symbol);

    size_t pairs_added = 0;
    g_pairs[out_idx + pairs_added].item = g_call_label[i];
    g_pairs[out_idx + pairs_added].value = g_call_action[i];
    pairs_added++;

    switch (verb->verb) {
        case CS_VERB_TRANSFER_PRIV_PUB:
        case CS_VERB_TRANSFER_PRIV_PRIV:
        case CS_VERB_TRANSFER_PUB_PRIV:
        case CS_VERB_TRANSFER_PUB_PUB: {
            /* args = [from, to, amount, nonce] */
            format_from(g_call_from[i], sizeof(g_call_from[i]), c->args[0]);
            short_hex_field(g_call_to[i], sizeof(g_call_to[i]), c->args[1]);
            char amt[CS_FORMAT_MAX_LEN];
            if (!cs_format_amount(c->args[2], reg->decimals, amt, sizeof(amt))) {
                snprintf(amt, sizeof(amt), "?");
            }
            snprintf(g_call_amount[i], sizeof(g_call_amount[i]),
                     "%s %s", amt, reg->symbol);
            format_mode(g_call_mode[i], sizeof(g_call_mode[i]), c->flags);

            g_pairs[out_idx + pairs_added].item = "From"; g_pairs[out_idx + pairs_added].value = g_call_from[i]; pairs_added++;
            g_pairs[out_idx + pairs_added].item = "To";   g_pairs[out_idx + pairs_added].value = g_call_to[i];   pairs_added++;
            g_pairs[out_idx + pairs_added].item = "Amount"; g_pairs[out_idx + pairs_added].value = g_call_amount[i]; pairs_added++;
            g_pairs[out_idx + pairs_added].item = "Mode"; g_pairs[out_idx + pairs_added].value = g_call_mode[i]; pairs_added++;
            break;
        }
        case CS_VERB_MINT_PUB:
        case CS_VERB_MINT_PRIV: {
            /* args = [to, amount] */
            short_hex_field(g_call_to[i], sizeof(g_call_to[i]), c->args[0]);
            char amt[CS_FORMAT_MAX_LEN];
            if (!cs_format_amount(c->args[1], reg->decimals, amt, sizeof(amt))) {
                snprintf(amt, sizeof(amt), "?");
            }
            snprintf(g_call_amount[i], sizeof(g_call_amount[i]),
                     "%s %s", amt, reg->symbol);

            /* Mint-action warning pair (codex M5 plan §5 + opus suggestion). */
            g_pairs[out_idx + pairs_added].item = "WARNING";
            g_pairs[out_idx + pairs_added].value = "MINTER action";
            pairs_added++;
            g_pairs[out_idx + pairs_added].item = "To"; g_pairs[out_idx + pairs_added].value = g_call_to[i]; pairs_added++;
            g_pairs[out_idx + pairs_added].item = "Amount"; g_pairs[out_idx + pairs_added].value = g_call_amount[i]; pairs_added++;
            break;
        }
        case CS_VERB_SPONSOR: {
            snprintf(g_call_via[i], sizeof(g_call_via[i]),
                     "Testnet %s", reg->symbol);
            g_pairs[out_idx + pairs_added].item = "Via";
            g_pairs[out_idx + pairs_added].value = g_call_via[i];
            pairs_added++;
            break;
        }
        default:
            break;
    }
    return pairs_added;
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
    g_pairs[n_pairs].item = "Path";     g_pairs[n_pairs].value = g_path_str;        n_pairs++;
    g_pairs[n_pairs].item = "Account";  g_pairs[n_pairs].value = g_account_str;     n_pairs++;
    g_pairs[n_pairs].item = "Chain";    g_pairs[n_pairs].value = g_chain_str;       n_pairs++;
    g_pairs[n_pairs].item = "Calls";    g_pairs[n_pairs].value = g_calls_count_str; n_pairs++;

    for (uint8_t i = 0; i < G_l4_session.call_count && n_pairs + 5 <= VC_PAIR_CAPACITY; i++) {
        n_pairs += render_call_pairs(i, n_pairs);
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
