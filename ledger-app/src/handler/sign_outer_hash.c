/**
 * SIGN_OUTER_HASH — Aztec K1 path (L2 baseline).
 *
 * Exact ECDSA call semantics per plan-final §2 / final-critique §1:
 *   digest = sha256(outer_hash)
 *   cx_ecdsa_sign_rs_no_throw(&priv_k1, CX_RND_RFC6979, CX_SHA256, digest, 32, r, s, &info)
 *
 * BOLOS does NOT guarantee low-S — we normalize device-side (final critique §10).
 * Fault-injection defense (final critique §9): duplicate-check r/s bytes before return.
 */

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>

#include "os.h"
#include "cx.h"
#include "io.h"
#include "buffer.h"
#include "crypto_helpers.h"

#include "sign_outer_hash.h"
#include "../globals.h"
#include "../sw.h"
#include "../ui/display.h"

const uint8_t SECP256K1_N[32] = {
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b,
    0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
};

static const uint8_t SECP256K1_HALF_N[32] = {
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d,
    0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
};

/** Returns true if `s > n/2`. Constant-time-ish — comparison loop doesn't early-exit. */
static bool s_is_high(const uint8_t *s) {
    int cmp = 0;
    for (size_t i = 0; i < 32; i++) {
        // Three-way compare: set `cmp` to -1, 0, or 1 the first time bytes differ.
        // Use mask trick to avoid branch on secret-derived data.
        int diff = (int) s[i] - (int) SECP256K1_HALF_N[i];
        int already = (cmp != 0) ? 1 : 0;
        cmp = already ? cmp : (diff > 0 ? 1 : (diff < 0 ? -1 : 0));
    }
    return cmp > 0;
}

/** s := n - s, byte-by-byte BE subtraction. */
static void low_s_normalize(uint8_t *s) {
    uint16_t borrow = 0;
    for (int i = 31; i >= 0; i--) {
        int32_t v = (int32_t) SECP256K1_N[i] - (int32_t) s[i] - (int32_t) borrow;
        if (v < 0) {
            v += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        s[i] = (uint8_t) v;
    }
}

int handler_sign_outer_hash(buffer_t *cdata) {
    explicit_bzero(&G_context, sizeof(G_context));
    G_context.req_type = REQ_SIGN_OUTER_HASH;

    // Parse path
    if (!buffer_read_u8(cdata, &G_context.bip32_path_len)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    // BIP-32 path bounds — must be non-empty (defense vs. malformed APDU; codex L2 BLOCKER #1).
    if (G_context.bip32_path_len == 0) {
        return io_send_sw(SW_INVALID_PATH_SCHEME);
    }
    if (G_context.bip32_path_len > MAX_BIP32_PATH_LEN) {
        return io_send_sw(SW_BIP32_TOO_LONG);
    }
    if (!buffer_read_bip32_path(cdata, G_context.bip32_path, G_context.bip32_path_len)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    // Parse outer_hash (32 bytes BE)
    if (!buffer_read_bytes(cdata, G_context.sign_info.outer_hash, AZTEC_OUTER_HASH_LEN)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    // Reject trailing bytes — protects against host-side framing bugs / malicious padding.
    if (cdata->size != cdata->offset) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }

    // Defer the actual signing until the user approves on-device.
    return ui_display_blind_sign();
}

/**
 * Called by the UI layer once the user approves the blind-sign confirmation.
 * Performs the actual ECDSA signature + low-S normalization + duplicate-check, then sends the response.
 */
int sign_outer_hash_after_approval(void) {
    // 1) Device-side SHA-256 of outer_hash.
    //    `cx_hash_sha256` returns the digest length (32) on success — NOT a cx_err_t.
    uint8_t digest[32];
    size_t digest_len = cx_hash_sha256(G_context.sign_info.outer_hash, AZTEC_OUTER_HASH_LEN, digest, sizeof(digest));
    if (digest_len != 32) {
        explicit_bzero(&G_context, sizeof(G_context));
        return io_send_sw(SWO_UNKNOWN);
    }

    // 2) ECDSA sign with RFC-6979 deterministic k.
    //    SDK signature: bip32_derive_ecdsa_sign_rs_hash_256(curve, path, path_len,
    //                       sign_mode, hashID, hash, hash_len, sig_r[32], sig_s[32], info*)
    //    No length out-params — r/s are always 32 bytes (big-endian, zero-padded).
    uint8_t r[32];
    uint8_t s[32];
    uint32_t info = 0;
    cx_err_t err = bip32_derive_ecdsa_sign_rs_hash_256(CX_CURVE_256K1,
                                                       G_context.bip32_path,
                                                       G_context.bip32_path_len,
                                                       CX_RND_RFC6979,
                                                       CX_SHA256,
                                                       digest, sizeof(digest),
                                                       r,
                                                       s,
                                                       &info);
    if (err != CX_OK) {
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        explicit_bzero(&G_context, sizeof(G_context));
        return io_send_sw(SWO_UNKNOWN);
    }

    // 3) Device-side low-S normalization (BOLOS doesn't guarantee).
    if (s_is_high(s)) {
        low_s_normalize(s);
    }

    // 4) Duplicate-check r and s before serializing (fault-injection defense per critique §9).
    //    Re-derive the signature into a second buffer and byte-compare.
    uint8_t r2[32];
    uint8_t s2[32];
    uint32_t info2 = 0;
    err = bip32_derive_ecdsa_sign_rs_hash_256(CX_CURVE_256K1,
                                              G_context.bip32_path,
                                              G_context.bip32_path_len,
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
        explicit_bzero(&G_context, sizeof(G_context));
        return io_send_sw(SWO_UNKNOWN);
    }
    if (s_is_high(s2)) {
        low_s_normalize(s2);
    }
    if (memcmp(r, r2, 32) != 0 || memcmp(s, s2, 32) != 0) {
        // Fault detected — bail.
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        explicit_bzero(r2, sizeof(r2));
        explicit_bzero(s2, sizeof(s2));
        explicit_bzero(&G_context, sizeof(G_context));
        return io_send_sw(SW_DUP_SIG_MISMATCH);
    }

    // 5) Emit r || s
    uint8_t response[ECDSA_K1_SIG_LEN];
    memcpy(response, r, 32);
    memcpy(response + 32, s, 32);

    // Hygiene before returning
    explicit_bzero(r, sizeof(r));
    explicit_bzero(s, sizeof(s));
    explicit_bzero(r2, sizeof(r2));
    explicit_bzero(s2, sizeof(s2));
    int rc = io_send_response_pointer(response, sizeof(response), SWO_SUCCESS);
    explicit_bzero(&G_context, sizeof(G_context));
    return rc;
}

int sign_outer_hash_rejected(void) {
    explicit_bzero(&G_context, sizeof(G_context));
    return io_send_sw(SW_USER_REJECTED);
}
