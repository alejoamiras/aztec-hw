/**
 * M11 P4 — shared account-binding primitives. See account_binding.h.
 */
#include "account_binding.h"

#include <string.h>

#include "os.h"
#include "cx.h"
#include "crypto_helpers.h"

int account_binding_secp256k1_pubkey_xy(const uint32_t *bip32_path, size_t bip32_path_len,
                                        uint8_t out_x[32], uint8_t out_y[32]) {
    uint8_t raw[65]; /* 0x04 || X(32) || Y(32) */
    uint8_t chain_code[32];
    cx_err_t err = bip32_derive_get_pubkey_256(CX_CURVE_256K1, bip32_path, bip32_path_len, raw,
                                               chain_code, CX_SHA512);
    explicit_bzero(chain_code, sizeof(chain_code));
    if (err != CX_OK || raw[0] != 0x04) {
        explicit_bzero(raw, sizeof(raw));
        return -1;
    }
    memcpy(out_x, &raw[1], 32);
    memcpy(out_y, &raw[33], 32);
    explicit_bzero(raw, sizeof(raw));
    return 0;
}
