/**
 * INS_GET_AZTEC_MASTER_SECRET (M8 P4).
 *
 * Derives the 32-byte Aztec master secret (an Fr) from the BIP-32 secp256k1
 * child pubkey:
 *
 *   secret = SHA-512(DOMAIN || pubkey_x(32) || pubkey_y(32)) mod Fr
 *   DOMAIN = "aztec-master-secret-v1" + one NUL byte (23 bytes total)
 *
 * Fr is the BN254 scalar field (poseidon2 fr_t / AZ_FR_P, 0x...f0000001) --
 * the field Aztec deriveKeys(secretKey: Fr) consumes. The reduction is the
 * wide reduction fr_from_bytes_wide_be (host-parity-tested).
 *
 * This INS discloses note-VIEWING capability (the host re-derives the four
 * viewing keys via deriveKeys), NOT spend authority. It is gated behind a
 * high-friction NBGL reveal screen.
 *
 * Flow mirrors finalize_deploy_and_sign: derive + arm the secret, show the
 * reveal UI, return 0 (deferred). The UI confirm/reject callback emits the
 * response via master_secret_reveal_approved / _rejected.
 *
 * Fault hardening: the derivation runs TWICE and the two results are compared
 * (constant-time) before arming -- a single-fault glitch that corrupts the
 * derivation is caught (mirrors the duplicate-sign discipline in the sign
 * handlers).
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
#include "nbgl_use_case.h"

#include "get_aztec_master_secret.h"
#include "../constants.h"
#include "../globals.h"
#include "../sw.h"
#include "../ui/display.h"
#include "../crypto/poseidon2/fr.h"

/* "aztec-master-secret-v1" is 22 chars; in a [23] array the literal zero-fills
 * index 22, giving the 23-byte DOMAIN (incl. trailing NUL) the host mirrors. */
static const uint8_t MASTER_SECRET_DOMAIN[23] = "aztec-master-secret-v1";
static const uint8_t CHECKSUM_TAG[19] = "aztec-vk-confirm-v1"; /* 19 chars, no NUL needed */

/* Armed across the deferred UI confirm. Secret material -- wiped on emit. */
static uint8_t s_secret[32];
static char s_checksum[5]; /* 4 hex + NUL */
static bool s_armed;

static const char HEXC[] = "0123456789abcdef";

/* Constant-time 32-byte compare. Returns 0 on equal. */
static int ct_memcmp32(const uint8_t a[32], const uint8_t b[32]) {
    uint8_t diff = 0;
    for (int i = 0; i < 32; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff;
}

static void disarm(void) {
    explicit_bzero(s_secret, sizeof(s_secret));
    s_armed = false;
}

/* Derive the master secret into `out32` from the path in G_context. Returns 0
 * on success. Touches only stack + out; no globals beyond G_context (read). */
static int derive_master_secret(uint8_t out32[32]) {
    uint8_t raw_pubkey[65];
    uint8_t chain_code[32];
    cx_err_t err = bip32_derive_get_pubkey_256(CX_CURVE_256K1,
                                               G_context.bip32_path,
                                               G_context.bip32_path_len,
                                               raw_pubkey,
                                               chain_code,
                                               CX_SHA512);
    explicit_bzero(chain_code, sizeof(chain_code));
    if (err != CX_OK || raw_pubkey[0] != 0x04) {
        explicit_bzero(raw_pubkey, sizeof(raw_pubkey));
        return -1;
    }

    /* input = DOMAIN(23) || X(32) || Y(32) = 87 bytes. raw_pubkey[1..65) is X||Y. */
    uint8_t input[23 + 64];
    memcpy(input, MASTER_SECRET_DOMAIN, 23);
    memcpy(input + 23, &raw_pubkey[1], 64);
    explicit_bzero(raw_pubkey, sizeof(raw_pubkey));

    uint8_t digest[64];
    if (cx_hash_sha512(input, sizeof(input), digest, sizeof(digest)) != 64) {
        explicit_bzero(input, sizeof(input));
        explicit_bzero(digest, sizeof(digest));
        return -1;
    }
    explicit_bzero(input, sizeof(input));

    fr_t reduced;
    fr_from_bytes_wide_be(&reduced, digest);
    explicit_bzero(digest, sizeof(digest));
    fr_to_bytes_be(out32, &reduced);
    explicit_bzero(&reduced, sizeof(reduced));
    return 0;
}

int handler_get_aztec_master_secret(buffer_t *cdata) {
    disarm();
    explicit_bzero(&G_context, sizeof(G_context));
    G_context.req_type = REQ_GET_PUBLIC_KEY; /* reuse the path-bearing context */

    if (!buffer_read_u8(cdata, &G_context.bip32_path_len)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    /* Need at least the 44'/AZTEC' prefix to gate the reveal to Aztec paths. */
    if (G_context.bip32_path_len < 2) {
        return io_send_sw(SW_INVALID_PATH_SCHEME);
    }
    if (G_context.bip32_path_len > MAX_BIP32_PATH_LEN) {
        return io_send_sw(SW_BIP32_TOO_LONG);
    }
    if (!buffer_read_bip32_path(cdata, G_context.bip32_path, G_context.bip32_path_len)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    if (cdata->size != cdata->offset) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    /* Canonical Aztec path prefix -- same gate as begin_deploy_account. */
    if (G_context.bip32_path[0] != (0x80000000u | 44u)) {
        return io_send_sw(SW_INVALID_PATH_SCHEME);
    }
    if (G_context.bip32_path[1] != AZTEC_COIN_TYPE_HARDENED) {
        return io_send_sw(SW_INVALID_PATH_SCHEME);
    }

    /* Derive twice + compare (fault hardening). */
    uint8_t pass1[32];
    uint8_t pass2[32];
    if (derive_master_secret(pass1) != 0) {
        explicit_bzero(pass1, sizeof(pass1));
        return io_send_sw(SWO_UNKNOWN);
    }
    if (derive_master_secret(pass2) != 0) {
        explicit_bzero(pass1, sizeof(pass1));
        explicit_bzero(pass2, sizeof(pass2));
        return io_send_sw(SWO_UNKNOWN);
    }
    if (ct_memcmp32(pass1, pass2) != 0) {
        explicit_bzero(pass1, sizeof(pass1));
        explicit_bzero(pass2, sizeof(pass2));
        return io_send_sw(SW_DUP_SIG_MISMATCH);
    }
    explicit_bzero(pass2, sizeof(pass2));

    /* Confirmation checksum: SHA-256(CHECKSUM_TAG || secret)[0..2] as 4 hex. */
    uint8_t cinput[19 + 32];
    memcpy(cinput, CHECKSUM_TAG, 19);
    memcpy(cinput + 19, pass1, 32);
    uint8_t cdigest[32];
    if (cx_hash_sha256(cinput, sizeof(cinput), cdigest, sizeof(cdigest)) != 32) {
        explicit_bzero(cinput, sizeof(cinput));
        explicit_bzero(pass1, sizeof(pass1));
        return io_send_sw(SWO_UNKNOWN);
    }
    explicit_bzero(cinput, sizeof(cinput));
    s_checksum[0] = HEXC[(cdigest[0] >> 4) & 0x0f];
    s_checksum[1] = HEXC[cdigest[0] & 0x0f];
    s_checksum[2] = HEXC[(cdigest[1] >> 4) & 0x0f];
    s_checksum[3] = HEXC[cdigest[1] & 0x0f];
    s_checksum[4] = '\0';

    memcpy(s_secret, pass1, 32);
    explicit_bzero(pass1, sizeof(pass1));
    s_armed = true;

    return ui_display_master_secret_reveal();
}

int master_secret_reveal_approved(void) {
    if (!s_armed) {
        return io_send_sw(SWO_UNKNOWN);
    }
    uint8_t response[32];
    memcpy(response, s_secret, 32);
    disarm();
    int rc = io_send_response_pointer(response, sizeof(response), SWO_SUCCESS);
    explicit_bzero(response, sizeof(response));
    /* M6.11 regression guard -- dismiss the NBGL page after the reveal.
     * STATUS_TYPE_OPERATION_SIGNED renders a generic "done" screen (this is a
     * key reveal, not a tx sign). Verify the enum name on the first Speculos
     * build; fall back to STATUS_TYPE_TRANSACTION_SIGNED if unavailable. */
    nbgl_useCaseReviewStatus(STATUS_TYPE_OPERATION_SIGNED, ui_menu_main);
    return rc;
}

int master_secret_reveal_rejected(void) {
    disarm();
    int rc = io_send_sw(SW_USER_REJECTED);
    nbgl_useCaseReviewStatus(STATUS_TYPE_OPERATION_REJECTED, ui_menu_main);
    return rc;
}

const char *master_secret_checksum_str(void) {
    return s_checksum;
}
