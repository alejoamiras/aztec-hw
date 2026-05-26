#pragma once

#include "buffer.h"

/**
 * BEGIN_AUTHWIT (INS 0x05) — start a new L4 verified-calls session.
 *
 * Body layout (single APDU, body bytes parsed left-to-right):
 *   uint8_t  manifest_version    // must be L4_MANIFEST_VERSION (=2 since M5.1)
 *   uint8_t  curve_id            // must be L4_CURVE_ID_K1 (=1) for L4
 *   uint8_t  path_scheme         // must be L4_PATH_SCHEME_DEFAULT (=0)
 *   uint8_t  bip32_path_len      // L4_MIN_BIP32_PATH..MAX_BIP32_PATH_LEN
 *   uint32_t bip32_path[path_len] // big-endian
 *   uint8_t  consumer[32]        // canonical Fr BE
 *   uint8_t  chain_id[32]        // canonical Fr BE
 *   uint8_t  protocol_version[32]// canonical Fr BE (chainInfo.version)
 *   uint8_t  tx_nonce[32]        // canonical Fr BE
 *   uint8_t  call_count          // 0..L4_MAX_CALLS (=5)
 *
 * Side effects: zeroes G_l4_session then populates it. Returns SW=9000 on
 * success (no response body); any non-9000 return zeroes the session.
 */
int handler_begin_authwit(buffer_t *cdata);
