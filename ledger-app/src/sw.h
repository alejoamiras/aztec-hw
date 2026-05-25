#pragma once

#include "status_words.h"

/**
 * Aztec-specific status words.
 *
 * Allocated from the proprietary 6Fxx range (per ISO 7816-4) to avoid collisions
 * with the SDK's ISO-standard `SWO_*` codes in `include/status_words.h`.
 */
#define SW_HASH_MISMATCH              0x6F01
#define SW_UNKNOWN_MANIFEST_VERSION   0x6F02
#define SW_INVALID_PATH_SCHEME        0x6F03
#define SW_INVALID_CURVE_ID           0x6F04
#define SW_BIP32_TOO_LONG             0x6F05
#define SW_DUP_SIG_MISMATCH           0x6F06
#define SW_USER_REJECTED              0x6985
