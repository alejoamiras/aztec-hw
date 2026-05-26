/**
 * FINALIZE_AND_SIGN — parity gate + fault-hardened ECDSA over sha256(outer_hash).
 *
 * Three independent recomputations of outer_hash bound this handler:
 *   - Two BEFORE UI is shown (both must match claimed_outer_hash).
 *   - One INSIDE finalize_after_approval (must match the stored value).
 *
 * Any mismatch zeroes the session and returns SW_HASH_MISMATCH. The signing
 * step replicates the L2 K1 path (sha256 + RFC-6979 + low-S + duplicate
 * signature check from sign_outer_hash.c).
 */
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "os.h"
#include "cx.h"
#include "io.h"
#include "buffer.h"
#include "crypto_helpers.h"

#include "finalize_and_sign.h"
#include "sign_outer_hash.h"
#include "../constants.h"
#include "../sw.h"
#include "../l4/fr_canonical.h"
#include "../l4/session.h"
#include "../l4/wire.h"
#include "../l4/parity.h"
#include "../ui/display.h"

/* sign_outer_hash.c exports n (the secp256k1 order) — reuse it. */
extern const uint8_t SECP256K1_N[32];

static const uint8_t SECP256K1_HALF_N_L4[32] = {
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d,
    0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
};

/* Bail-out helper: clear the session and return the given SW. */
static int reject(uint16_t sw) {
    l4_session_reset();
    return io_send_sw(sw);
}

/* Constant-time-ish 32-byte compare. Returns 0 on equal. */
static int ct_memcmp32(const uint8_t a[32], const uint8_t b[32]) {
    uint8_t diff = 0;
    for (int i = 0; i < 32; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff;
}

static bool s_is_high(const uint8_t *s) {
    int cmp = 0;
    for (size_t i = 0; i < 32; i++) {
        int diff = (int)s[i] - (int)SECP256K1_HALF_N_L4[i];
        int already = (cmp != 0) ? 1 : 0;
        cmp = already ? cmp : (diff > 0 ? 1 : (diff < 0 ? -1 : 0));
    }
    return cmp > 0;
}

static void low_s_normalize(uint8_t *s) {
    uint16_t borrow = 0;
    for (int i = 31; i >= 0; i--) {
        int32_t v = (int32_t)SECP256K1_N[i] - (int32_t)s[i] - (int32_t)borrow;
        if (v < 0) {
            v += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        s[i] = (uint8_t)v;
    }
}

int handler_finalize_and_sign(buffer_t *cdata) {
    if (G_l4_session.state != L4_CALLS_COMPLETE) return reject(SWO_INVALID_INS);

    if (!buffer_read_bytes(cdata, G_l4_session.claimed_outer_hash, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (cdata->size != cdata->offset) return reject(SWO_WRONG_DATA_LENGTH);
    /* codex L4 MINOR — `claimed_outer_hash` must be a canonical Fr too;
     * length-only check was spec drift. */
    if (!l4_fr_is_canonical(G_l4_session.claimed_outer_hash)) {
        return reject(SW_HASH_MISMATCH);
    }

    /* --- Parity pass 1 ------------------------------------------------- */
    uint8_t computed_outer[L4_FR_BYTES];
    uint8_t computed_inner[L4_FR_BYTES];
    if (!l4_compute_outer_hash(computed_outer, computed_inner)) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(computed_outer, G_l4_session.claimed_outer_hash) != 0) {
        return reject(SW_HASH_MISMATCH);
    }

    /* --- Parity pass 2 (fault detection, deep plan §5) ----------------- */
    uint8_t computed_outer_2[L4_FR_BYTES];
    uint8_t computed_inner_2[L4_FR_BYTES];
    if (!l4_compute_outer_hash(computed_outer_2, computed_inner_2)) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(computed_outer_2, G_l4_session.claimed_outer_hash) != 0) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(computed_outer, computed_outer_2) != 0) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(computed_inner, computed_inner_2) != 0) {
        return reject(SW_HASH_MISMATCH);
    }

    /* Stash the device-recomputed values for UI + signing step. */
    memcpy(G_l4_session.outer_hash, computed_outer, L4_FR_BYTES);
    memcpy(G_l4_session.inner_hash, computed_inner, L4_FR_BYTES);

    /* UI calls finalize_after_approval / finalize_rejected on user choice. */
    return ui_display_verified_calls();
}

int finalize_after_approval(void) {
    /* --- Parity pass 3 (just before signing) --------------------------- */
    uint8_t recheck_outer[L4_FR_BYTES];
    uint8_t recheck_inner[L4_FR_BYTES];
    if (!l4_compute_outer_hash(recheck_outer, recheck_inner)) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(recheck_outer, G_l4_session.outer_hash) != 0) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(recheck_outer, G_l4_session.claimed_outer_hash) != 0) {
        return reject(SW_HASH_MISMATCH);
    }

    /* Sign sha256(outer_hash) via the K1 path. */
    uint8_t digest[32];
    size_t digest_len = cx_hash_sha256(G_l4_session.outer_hash, L4_FR_BYTES, digest, sizeof(digest));
    if (digest_len != 32) {
        return reject(SWO_UNKNOWN);
    }

    uint8_t r[32], s[32];
    uint32_t info = 0;
    cx_err_t err = bip32_derive_ecdsa_sign_rs_hash_256(CX_CURVE_256K1,
                                                       G_l4_session.bip32_path,
                                                       G_l4_session.bip32_path_len,
                                                       CX_RND_RFC6979,
                                                       CX_SHA256,
                                                       digest, sizeof(digest),
                                                       r,
                                                       s,
                                                       &info);
    if (err != CX_OK) {
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        return reject(SWO_UNKNOWN);
    }
    if (s_is_high(s)) low_s_normalize(s);

    /* Duplicate signature check — fault defense (sign_outer_hash.c parity). */
    uint8_t r2[32], s2[32];
    uint32_t info2 = 0;
    err = bip32_derive_ecdsa_sign_rs_hash_256(CX_CURVE_256K1,
                                              G_l4_session.bip32_path,
                                              G_l4_session.bip32_path_len,
                                              CX_RND_RFC6979,
                                              CX_SHA256,
                                              digest, sizeof(digest),
                                              r2,
                                              s2,
                                              &info2);
    if (err != CX_OK) {
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        explicit_bzero(r2, sizeof(r2));
        explicit_bzero(s2, sizeof(s2));
        return reject(SWO_UNKNOWN);
    }
    if (s_is_high(s2)) low_s_normalize(s2);
    if (memcmp(r, r2, 32) != 0 || memcmp(s, s2, 32) != 0) {
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        explicit_bzero(r2, sizeof(r2));
        explicit_bzero(s2, sizeof(s2));
        return reject(SW_DUP_SIG_MISMATCH);
    }

    uint8_t response[ECDSA_K1_SIG_LEN];
    memcpy(response, r, 32);
    memcpy(response + 32, s, 32);

    explicit_bzero(r, sizeof(r));
    explicit_bzero(s, sizeof(s));
    explicit_bzero(r2, sizeof(r2));
    explicit_bzero(s2, sizeof(s2));

    int rc = io_send_response_pointer(response, sizeof(response), SWO_SUCCESS);
    l4_session_reset();
    return rc;
}

int finalize_rejected(void) {
    l4_session_reset();
    return io_send_sw(SW_USER_REJECTED);
}
