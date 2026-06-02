/**
 * INS_GET_SCHNORR_PUBKEY (M10). See get_schnorr_pubkey.h. Mirrors
 * get_public_key.c, but derives the Grumpkin Schnorr signing scalar device-side
 * (az_derive_schnorr_signing_scalar) and returns P = priv·G.
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "os.h"
#include "io.h"
#include "buffer.h"

#include "get_schnorr_pubkey.h"
#include "../constants.h"
#include "../globals.h"
#include "../path_canonical.h"
#include "../sw.h"
#include "../crypto/schnorr.h"
#include "../l4/aztec_secret.h"

int handler_get_schnorr_pubkey(buffer_t *cdata) {
    explicit_bzero(&G_context, sizeof(G_context));
    G_context.req_type = REQ_GET_PUBLIC_KEY; /* reuse the path-bearing context */

    if (!buffer_read_u8(cdata, &G_context.bip32_path_len)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    if (G_context.bip32_path_len == 0) {
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
    /* AHW-064: enforce the canonical Aztec path on the Schnorr pubkey export too. */
    if (!az_bip32_path_is_canonical(G_context.bip32_path, G_context.bip32_path_len)) {
        return io_send_sw(SW_INVALID_PATH_SCHEME);
    }

    uint8_t priv[32];
    if (az_derive_schnorr_signing_scalar(G_context.bip32_path, G_context.bip32_path_len, priv) != 0) {
        explicit_bzero(priv, sizeof(priv));
        return io_send_sw(SWO_UNKNOWN);
    }

    uint8_t response[64]; /* X(32) || Y(32) */
    bool ok = schnorr_grumpkin_pubkey(response, response + 32, priv);
    explicit_bzero(priv, sizeof(priv));
    if (!ok) {
        explicit_bzero(response, sizeof(response));
        return io_send_sw(SWO_UNKNOWN);
    }
    return io_send_response_pointer(response, sizeof(response), SWO_SUCCESS);
}
