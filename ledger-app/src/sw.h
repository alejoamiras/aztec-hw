#pragma once

#include "status_words.h"

/**
 * Aztec-specific status words.
 *
 * Allocated from the proprietary 6Fxx range (per ISO 7816-4) to avoid collisions
 * with the SDK's ISO-standard `SWO_*` codes in `include/status_words.h`.
 */
#define SW_HASH_MISMATCH                  0x6F01
#define SW_UNKNOWN_MANIFEST_VERSION       0x6F02
#define SW_INVALID_PATH_SCHEME            0x6F03
#define SW_INVALID_CURVE_ID               0x6F04
#define SW_BIP32_TOO_LONG                 0x6F05
#define SW_DUP_SIG_MISMATCH               0x6F06
#define SW_NOT_IMPLEMENTED                0x6F07  // INS reserved for a future phase
/* Clear-signing v0 strict-allowlist rejections (codex final-review §4). */
#define SW_REGISTRY_MISS                  0x6F08  // target address not in CS_REGISTRY
#define SW_DECODER_MISS                   0x6F09  // (kind, selector) not in CS_VERBS
#define SW_DECODER_DESYNC                 0x6F0A  // wire arg_count != verb's expected
#define SW_VISIBILITY_MISMATCH            0x6F0B  // flags.is_public != verb's is_public
#define SW_DELEGATED_SPEND_UNSUPPORTED    0x6F0C  // 4-arg transfer with from != consumer
#define SW_USER_REJECTED                  0x6985
