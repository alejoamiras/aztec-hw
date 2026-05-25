/**
 * GET_PUBLIC_KEY — derive Aztec K1 signing public key.
 *
 * Returns 64-byte `X || Y` (no SEC1 prefix) so the host can drop it directly into
 * Aztec's `EcdsaKAccount` constructor args.
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

#include "get_public_key.h"
#include "../globals.h"
#include "../sw.h"
#include "../ui/display.h"

int handler_get_public_key(buffer_t *cdata, bool display) {
    explicit_bzero(&G_context, sizeof(G_context));
    G_context.req_type = REQ_GET_PUBLIC_KEY;

    if (!buffer_read_u8(cdata, &G_context.bip32_path_len)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    if (G_context.bip32_path_len > MAX_BIP32_PATH_LEN) {
        return io_send_sw(SW_BIP32_TOO_LONG);
    }
    if (!buffer_read_bip32_path(cdata, G_context.bip32_path, G_context.bip32_path_len)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }

    cx_err_t error = bip32_derive_get_pubkey_256(CX_CURVE_256K1,
                                                 G_context.bip32_path,
                                                 G_context.bip32_path_len,
                                                 G_context.pk_info.raw_public_key,
                                                 G_context.pk_info.chain_code,
                                                 CX_SHA512);
    if (error != CX_OK) {
        return io_send_sw(error);
    }

    // L2 baseline: ignore `display` — pubkey UI confirmation lands with L4.
    (void) display;

    // Emit X(32) || Y(32) || chain_code(32) — strip the SEC1 0x04 prefix.
    uint8_t response[96];
    memcpy(response, &G_context.pk_info.raw_public_key[1], 64);
    memcpy(response + 64, G_context.pk_info.chain_code, 32);
    return io_send_response_pointer(response, sizeof(response), SWO_SUCCESS);
}
