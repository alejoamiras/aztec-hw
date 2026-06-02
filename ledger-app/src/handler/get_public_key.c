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
#include "../path_canonical.h"
#include "../sw.h"
#include "../ui/display.h"

int handler_get_public_key(buffer_t *cdata, bool display) {
    explicit_bzero(&G_context, sizeof(G_context));
    G_context.req_type = REQ_GET_PUBLIC_KEY;

    if (!buffer_read_u8(cdata, &G_context.bip32_path_len)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    // BIP-32 path bounds — must be non-empty (codex L2 BLOCKER #1).
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
    /* AHW-064: pubkey export is a dangerous surface that previously accepted any
     * 1..10-component path. Enforce the canonical Aztec path, matching the L4 gates. */
    if (!az_bip32_path_is_canonical(G_context.bip32_path, G_context.bip32_path_len)) {
        return io_send_sw(SW_INVALID_PATH_SCHEME);
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

    // L2 baseline: `display` mode lands with L4. Reject p1=1 explicitly so the host
    // can't claim a confirmation that never happened (codex L2 MINOR #7).
    if (display) {
        return io_send_sw(SWO_INCORRECT_P1_P2);
    }

    // Emit X(32) || Y(32) — strip the SEC1 0x04 prefix.
    // Per plan-final.md §215: K1 pubkey is 64B x||y. Chain code is not needed by Aztec
    // and was leaking a derivation-fingerprinting surface (codex L2 MAJOR #3).
    uint8_t response[64];
    memcpy(response, &G_context.pk_info.raw_public_key[1], 64);
    return io_send_response_pointer(response, sizeof(response), SWO_SUCCESS);
}
